import fs from "fs";
import type {
  BlockObjectResponse,
  ChildPageBlockObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import type { NotionParser } from "./notion_parser.js";
import type { NotionPageProperty, Plugin } from "./types.js";
import type { CacheData } from "./cache.js";
import {
  computeNodeFilePath,
  parseTitleForExtension,
  slugify,
} from "./util.js";
import { Logger } from "./logger.js";

/**
 * Represents a Notion page (content node) with its own content, metadata, and
 * sub-pages. Notion data is promoted to first-class fields so plugins don't
 * have to reach through optional chaining and `as any` casts.
 */
export type PageNode = {
  notionId: string;
  /** Plain-text page title as it appears in Notion's `child_page` block. */
  notionTitle: string;
  /** Fully-typed Notion page object. `null` until fetched (root before visit). */
  page: PageObjectResponse | null;
  /** Notion property map, or `null` until the page is fetched. */
  properties: PageObjectResponse["properties"] | null;
  /** Notion page icon (emoji / external / file / custom), or `null`. */
  icon: PageObjectResponse["icon"] | null;
  /** Notion's `last_edited_time` for the page. `null` until fetched. */
  lastEditedTime: string | null;
  /** Raw blocks for the page (paginated fully). Empty until fetched. */
  blocks: BlockObjectResponse[];
  /** Markdown converted from `blocks`. Empty when conversion was skipped. */
  mdString: string;
  /** Source `child_page` block this node was created from. `null` on root. */
  childPageBlock: ChildPageBlockObjectResponse | null;
  parentNode: PageNode | null;
  childNodes: PageNode[];
  /** Resolved output path for this node's file, computed during tree build. */
  filePath?: string;
  /** Directory where this node's children will be written. */
  childDir?: string;
  /** True when the page matches the cache and the existing output file is reusable. */
  unchanged?: boolean;
  /**
   * Title to use for slug derivation — equal to `notionTitle` unless a sibling
   * slug collision was resolved by appending a `-N` suffix.
   */
  resolvedTitle?: string;
  /**
   * True when a plugin's `filter` hook returned `false` during tree build. The
   * Generator honors this flag and skips the node (and its descendants).
   */
  filtered?: boolean;
};

/**
 * Returns the Notion page property named `name`, or `undefined` if absent.
 * Returns the raw property object (with its `type` discriminator) so callers
 * can narrow with `prop.type === "rich_text"` etc.
 */
export function getProperty(
  node: PageNode,
  name: string,
): NotionPageProperty | undefined {
  return node.properties?.[name];
}

export type BuildPageTreeOptions = {
  cache?: CacheData | undefined;
  contentDir: string;
  fileExtension: string;
  plugins?: Plugin[];
  /** Maximum concurrent Notion fetches during BFS. Defaults to 4. */
  concurrency?: number;
  logger?: Logger;
};

function makeNode(init: {
  notionId: string;
  notionTitle: string;
  parentNode: PageNode | null;
  childPageBlock: ChildPageBlockObjectResponse | null;
  resolvedTitle: string;
}): PageNode {
  return {
    notionId: init.notionId,
    notionTitle: init.notionTitle,
    page: null,
    properties: null,
    icon: null,
    lastEditedTime: null,
    blocks: [],
    mdString: "",
    childPageBlock: init.childPageBlock,
    parentNode: init.parentNode,
    childNodes: [],
    resolvedTitle: init.resolvedTitle,
  };
}

/**
 * Builds the page/node tree according to the layout in Notion, starting from the given root page ID.
 *
 * Nodes are fetched using a bounded worker pool (default concurrency: 4) so a
 * large tree doesn't serialize one round-trip at a time. Sibling order is
 * preserved by appending children to the parent in the order Notion returned
 * them, regardless of which worker finished first.
 *
 * When a cache is provided, each node is first fetched without markdown
 * conversion. If the page's `last_edited_time` and resolved output path match
 * the cache and the existing file is still on disk, the node is marked
 * `unchanged` so the Generator can skip writing it. Otherwise the markdown is
 * converted in-place so the rest of the pipeline behaves as before.
 *
 * `filter` hooks run immediately after the page is fetched and before children
 * are enqueued. If any plugin returns `false`, the node is marked `filtered`
 * (the Generator honors the flag and skips it) and its subtree is not even
 * fetched — saving an API round-trip per filtered descendant.
 *
 * Sibling slug collisions are detected per-directory at parent-visit time
 * (synchronously, in Notion's child order) so the result is deterministic
 * regardless of worker scheduling. The first sibling keeps the natural slug;
 * subsequent siblings get `-2`, `-3`, … and a warning is logged.
 *
 * If a plugin's `onError` hook suppresses a per-node failure, the failing
 * non-root node is dropped from its parent's `childNodes` and any of its
 * undiscovered subtree is skipped. Root failures always propagate — without a
 * root there's nothing to sync.
 */
export async function buildPageTree(
  rootId: string,
  notion: NotionParser,
  options: BuildPageTreeOptions,
) {
  const {
    cache,
    contentDir,
    fileExtension,
    plugins = [],
    concurrency = 4,
    logger,
  } = options;

  const rootNode = makeNode({
    notionId: rootId,
    notionTitle: "Root",
    parentNode: null,
    childPageBlock: null,
    resolvedTitle: "Root",
  });

  // Tracks slugs already taken in each directory so siblings can't collide.
  const usedSlugsByDir = new Map<string, Set<string>>();

  const visit = async (node: PageNode): Promise<PageNode[]> => {
    // Skip markdown conversion at fetch time — we may filter the node away
    // before we ever need the markdown. Convert lazily below if it survives.
    const retrieved = await notion.retrievePage(node.notionId, {
      skipMarkdown: true,
    });
    node.page = retrieved.page;
    node.properties = retrieved.page.properties;
    node.icon = retrieved.page.icon;
    node.lastEditedTime = retrieved.page.last_edited_time;
    node.blocks = retrieved.blocks;

    // Use the fetched page's title for the root, where the synthetic "Root"
    // placeholder isn't useful to plugins. Non-root nodes already carry the
    // child_page title from their parent's block list.
    if (node.parentNode === null) {
      const realTitle = extractPageTitle(retrieved.page);
      if (realTitle) {
        node.notionTitle = realTitle;
        // Don't overwrite resolvedTitle — the root file path is "<contentDir>/Root/..."
        // by convention; renaming after the fact would break existing layouts.
      }
    }

    const parentDir = node.parentNode?.childDir ?? contentDir;
    const hasChildren = retrieved.childPages.length > 0;
    const titleForPath = node.resolvedTitle ?? node.notionTitle;
    const { filePath, childDir } = computeNodeFilePath(
      titleForPath,
      parentDir,
      hasChildren,
      fileExtension,
    );
    node.filePath = filePath;
    node.childDir = childDir;

    // Run filter hooks as soon as we have a full node. A `false` result skips
    // the subtree entirely — no markdown conversion, no children enqueued.
    if (!(await runFilter(node, plugins))) {
      node.filtered = true;
      return [];
    }

    if (cache) {
      const cached = cache.pages[node.notionId];
      const unchanged =
        !!cached &&
        cached.lastEditedTime === retrieved.page.last_edited_time &&
        cached.filePath === filePath &&
        fs.existsSync(filePath);
      node.unchanged = unchanged;

      if (!unchanged) {
        node.mdString = await notion.convertBlocksToMarkdown(retrieved.blocks);
      }
    } else {
      node.mdString = await notion.convertBlocksToMarkdown(retrieved.blocks);
    }

    // Reserve unique sibling slugs in Notion's order, before any child is
    // dispatched for fetching. This keeps the collision-resolution
    // deterministic even though child visits run concurrently.
    const children: PageNode[] = [];
    for (const cp of retrieved.childPages) {
      const childTitle = cp.child_page.title;
      const resolvedTitle = reserveSiblingSlug(
        childTitle,
        childDir,
        usedSlugsByDir,
        logger,
        cp.id,
      );
      const newNode = makeNode({
        notionId: cp.id,
        notionTitle: childTitle,
        parentNode: node,
        childPageBlock: cp,
        resolvedTitle,
      });
      node.childNodes.push(newNode);
      children.push(newNode);
    }
    return children;
  };

  // Root is processed sequentially; if it fails there's nothing to recover.
  const rootChildren = await visit(rootNode);

  await runWorkerPool(rootChildren, concurrency, async (node) => {
    try {
      return await visit(node);
    } catch (err) {
      if (await runOnError(err, node, plugins)) {
        if (node.parentNode) {
          node.parentNode.childNodes = node.parentNode.childNodes.filter(
            (c) => c !== node,
          );
        }
        return [];
      }
      throw err;
    }
  });

  return rootNode;
}

/**
 * Worker-pool BFS: keep `concurrency` visits in flight at any time. Children
 * returned by a visit get appended to the queue for subsequent workers.
 */
async function runWorkerPool<T>(
  seed: T[],
  concurrency: number,
  worker: (item: T) => Promise<T[]>,
): Promise<void> {
  const queue: T[] = [...seed];
  let active = 0;
  let firstError: unknown = null;

  return new Promise((resolve, reject) => {
    const launch = () => {
      while (!firstError && active < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        active++;
        worker(item)
          .then((next) => {
            if (!firstError) queue.push(...next);
          })
          .catch((err) => {
            if (!firstError) firstError = err;
          })
          .finally(() => {
            active--;
            if (active === 0 && (firstError || queue.length === 0)) {
              if (firstError) reject(firstError);
              else resolve();
              return;
            }
            launch();
          });
      }
      if (active === 0 && queue.length === 0 && !firstError) resolve();
    };
    launch();
  });
}

/**
 * Picks a non-conflicting slug name for a sibling within `parentChildDir`.
 * The first sibling to claim a slug wins; later siblings get `-2`, `-3`, …
 * and a warning is logged.
 *
 * Returns the (possibly suffixed) title to store on the child node — slug
 * derivation later uses this title.
 */
function reserveSiblingSlug(
  title: string,
  parentChildDir: string,
  usedSlugsByDir: Map<string, Set<string>>,
  logger: Logger | undefined,
  notionId: string,
): string {
  const taken = usedSlugsByDir.get(parentChildDir) ?? new Set<string>();
  usedSlugsByDir.set(parentChildDir, taken);

  let attempt = 0;
  while (true) {
    const candidate =
      attempt === 0 ? title : appendSlugSuffix(title, attempt + 1);
    const slugKey = computeSlugKey(candidate);
    if (!taken.has(slugKey)) {
      taken.add(slugKey);
      if (attempt > 0 && logger) {
        logger.warn(
          `Slug collision in ${parentChildDir}: "${title}" already taken, using "${candidate}". Rename the page in Notion to make the slug unique.`,
          { notionId, originalTitle: title, resolvedTitle: candidate },
        );
      }
      return candidate;
    }
    attempt++;
    if (attempt > 1000) {
      throw new Error(
        `Unable to resolve slug collision for "${title}" in ${parentChildDir} after 1000 attempts.`,
      );
    }
  }
}

/**
 * The filesystem name a title would claim, regardless of whether the page
 * turns out to be a leaf or a directory. Includes the explicit extension so
 * `meta.json` and `meta.yaml` don't collide.
 */
function computeSlugKey(title: string): string {
  const { baseName, ext } = parseTitleForExtension(title);
  if (ext) return `${slugify(baseName)}.${ext}`;
  return slugify(title);
}

function appendSlugSuffix(title: string, n: number): string {
  const dot = title.lastIndexOf(".");
  if (dot > 0 && /^[a-zA-Z0-9]+$/.test(title.slice(dot + 1))) {
    return `${title.slice(0, dot)}-${n}${title.slice(dot)}`;
  }
  return `${title}-${n}`;
}

/** Returns `false` if any plugin's `filter` hook returns `false`. */
async function runFilter(node: PageNode, plugins: Plugin[]): Promise<boolean> {
  for (const plugin of plugins) {
    const filter = plugin.hooks?.filter;
    if (!filter) continue;
    if ((await filter(node)) === false) return false;
  }
  return true;
}

async function runOnError(
  err: unknown,
  node: PageNode,
  plugins: Plugin[],
): Promise<boolean> {
  let suppressed = false;
  for (const plugin of plugins) {
    const handler = plugin.hooks?.onError;
    if (!handler) continue;
    try {
      if ((await handler(err, node)) === true) suppressed = true;
    } catch {
      // Errors inside onError handlers are swallowed.
    }
  }
  return suppressed;
}

function extractPageTitle(page: PageObjectResponse): string | undefined {
  for (const prop of Object.values(page.properties)) {
    if (prop.type !== "title") continue;
    const text = prop.title.map((r) => r.plain_text).join("");
    if (text) return text;
  }
  return undefined;
}
