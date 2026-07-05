import fs from "fs";
import type {
  BlockObjectResponse,
  ChildDatabaseBlockObjectResponse,
  ChildPageBlockObjectResponse,
  DatabaseObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import type { NotionParser } from "./notion_parser.js";
import type { NodeKind, NotionPageProperty, Plugin } from "./types.js";
import type { CacheRoot } from "./cache.js";
import {
  computeNodeFilePath,
  parseTitleForExtension,
  slugify,
} from "./util.js";
import { Logger } from "./logger.js";

/**
 * Represents a Notion node (regular page or wiki/database) with its own
 * content, metadata, and sub-nodes. Notion data is promoted to first-class
 * fields so plugins don't have to reach through optional chaining and
 * `as any` casts.
 *
 * The `kind` discriminator lets the tree be heterogeneous: regular page
 * subtrees can contain a wiki at any depth, and a wiki's items are regular
 * pages that may themselves nest further. Wiki-kind fields are populated
 * only on wiki nodes; page-kind fields are populated only on page nodes.
 */
export type PageNode = {
  /** "page" for regular Notion pages. "wiki" for Notion databases (wikis). */
  kind: NodeKind;
  notionId: string;
  /** Plain-text title shown in the parent's block list. Updated from the page/db object on visit. */
  notionTitle: string;
  parentNode: PageNode | null;
  childNodes: PageNode[];
  /** Resolved output path for this node's file, or `undefined` for wiki nodes (directory-only). */
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
  /** Notion's `last_edited_time` for the underlying page/database. `null` until fetched. */
  lastEditedTime: string | null;

  // --- Page-kind fields (populated when kind === "page") ---
  /** Fully-typed Notion page object. `null` until fetched (root before visit). */
  page: PageObjectResponse | null;
  /** Notion property map, or `null` until the page is fetched. */
  properties: PageObjectResponse["properties"] | null;
  /** Notion page icon (emoji / external / file / custom), or `null`. */
  icon: PageObjectResponse["icon"] | null;
  /** Raw blocks for the page (paginated fully). Empty until fetched. */
  blocks: BlockObjectResponse[];
  /** Markdown converted from `blocks`. Empty when conversion was skipped. */
  mdString: string;
  /** Source `child_page` block this node was created from. `null` on root and wiki items. */
  childPageBlock: ChildPageBlockObjectResponse | null;

  // --- Wiki-kind fields (populated when kind === "wiki") ---
  /** Full database object. Populated only on wiki nodes. */
  database?: DatabaseObjectResponse | null;
  /** Database title rich text rendered to plain text. */
  databaseTitle?: string;
  /** Database description rich text rendered to plain text. */
  databaseDescription?: string;
  /** Source `child_database` block when discovered mid-traversal. `null` on root wikis. */
  childDatabaseBlock?: ChildDatabaseBlockObjectResponse | null;
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
  /** Per-root cache slice (or undefined to disable incremental sync for this root). */
  cache?: CacheRoot | undefined;
  contentDir: string;
  fileExtension: string;
  plugins?: Plugin[];
  /** Maximum concurrent Notion fetches during BFS. Defaults to 4. */
  concurrency?: number;
  logger?: Logger;
  /**
   * What kind of root this is. Defaults to `"page"`. Callers that have
   * already classified the root (e.g. the orchestrator) pass this in to
   * avoid an extra probe.
   */
  rootKind?: NodeKind;
};

function makePageNode(init: {
  notionId: string;
  notionTitle: string;
  parentNode: PageNode | null;
  childPageBlock: ChildPageBlockObjectResponse | null;
  resolvedTitle: string;
}): PageNode {
  return {
    kind: "page",
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

function makeWikiNode(init: {
  notionId: string;
  notionTitle: string;
  parentNode: PageNode | null;
  childDatabaseBlock: ChildDatabaseBlockObjectResponse | null;
  resolvedTitle: string;
}): PageNode {
  return {
    kind: "wiki",
    notionId: init.notionId,
    notionTitle: init.notionTitle,
    page: null,
    properties: null,
    icon: null,
    lastEditedTime: null,
    blocks: [],
    mdString: "",
    childPageBlock: null,
    childDatabaseBlock: init.childDatabaseBlock,
    parentNode: init.parentNode,
    childNodes: [],
    resolvedTitle: init.resolvedTitle,
    database: null,
  };
}

/**
 * Builds the page/node tree starting from the given root id.
 *
 * Heterogeneous: each node carries a `kind` discriminator. Regular pages are
 * fetched via `pages.retrieve` + `blocks.children.list`; wikis are fetched
 * via `databases.retrieve` + a paginated `dataSources.query`. Wiki items
 * become `kind: "page"` child nodes; `child_database` blocks encountered
 * inside a regular page become `kind: "wiki"` child nodes.
 *
 * Nodes are fetched using a bounded worker pool (default concurrency: 4) so
 * a large tree doesn't serialize one round-trip at a time. Sibling order is
 * preserved by appending children to the parent in the order Notion returned
 * them, regardless of which worker finished first.
 *
 * When a cache is provided, page nodes are first fetched without markdown
 * conversion. If the page's `last_edited_time` and resolved output path
 * match the cache and the existing file is still on disk, the node is
 * marked `unchanged` so the Generator can skip writing it. Otherwise the
 * markdown is converted in-place. Wiki nodes have no output file of their
 * own, so they bypass the cache check.
 *
 * `filter` hooks run immediately after the node is fetched and before
 * children are enqueued. If any plugin returns `false`, the node is marked
 * `filtered` (the Generator honors the flag and skips it) and its subtree
 * is not fetched.
 *
 * Sibling slug collisions are detected per-directory at parent-visit time
 * (synchronously, in Notion's child order) so the result is deterministic
 * regardless of worker scheduling. The first sibling keeps the natural
 * slug; subsequent siblings get `-2`, `-3`, … and a warning is logged.
 *
 * If a plugin's `onError` hook suppresses a per-node failure, the failing
 * non-root node is dropped from its parent's `childNodes` and any of its
 * undiscovered subtree is skipped. Root failures always propagate — without
 * a root there's nothing to sync.
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
    rootKind = "page",
  } = options;

  const rootNode: PageNode =
    rootKind === "wiki"
      ? makeWikiNode({
          notionId: rootId,
          notionTitle: "Root",
          parentNode: null,
          childDatabaseBlock: null,
          resolvedTitle: "Root",
        })
      : makePageNode({
          notionId: rootId,
          notionTitle: "Root",
          parentNode: null,
          childPageBlock: null,
          resolvedTitle: "Root",
        });

  // Tracks slugs already taken in each directory so siblings can't collide.
  const usedSlugsByDir = new Map<string, Set<string>>();

  const visit = async (node: PageNode): Promise<PageNode[]> => {
    if (node.kind === "wiki") {
      return visitWiki(
        node,
        notion,
        contentDir,
        fileExtension,
        plugins,
        usedSlugsByDir,
        logger,
      );
    }
    return visitPage(
      node,
      notion,
      contentDir,
      fileExtension,
      cache,
      plugins,
      usedSlugsByDir,
      logger,
    );
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
 * Visits a regular page node: fetch metadata, resolve its output path, run
 * filter hooks, optionally convert markdown, enqueue child pages and child
 * databases as further nodes.
 */
async function visitPage(
  node: PageNode,
  notion: NotionParser,
  contentDir: string,
  fileExtension: string,
  cache: CacheRoot | undefined,
  plugins: Plugin[],
  usedSlugsByDir: Map<string, Set<string>>,
  logger: Logger | undefined,
): Promise<PageNode[]> {
  const retrieved = await notion.retrievePage(node.notionId, {
    skipMarkdown: true,
  });
  node.page = retrieved.page;
  node.properties = retrieved.page.properties;
  node.icon = retrieved.page.icon;
  node.lastEditedTime = retrieved.page.last_edited_time;
  node.blocks = retrieved.blocks;

  // Use the fetched page's title for the root; the synthetic "Root"
  // placeholder isn't useful to plugins. Non-root nodes already carry the
  // child_page title from their parent's block list.
  if (node.parentNode === null) {
    const realTitle = extractPageTitle(retrieved.page);
    if (realTitle) node.notionTitle = realTitle;
  }

  const parentDir = node.parentNode?.childDir ?? contentDir;
  // Wiki items pre-attach their nested-item children via `visitWiki` before
  // the worker pool dispatches the item itself. Honor those pre-built
  // children so the item resolves as a directory-with-index, not a leaf.
  const hasChildren =
    retrieved.childPages.length > 0 ||
    retrieved.childDatabases.length > 0 ||
    node.childNodes.length > 0;
  const titleForPath = node.resolvedTitle ?? node.notionTitle;
  const { filePath, childDir } = computeNodeFilePath(
    titleForPath,
    parentDir,
    hasChildren,
    fileExtension,
  );
  node.filePath = filePath;
  node.childDir = childDir;

  if (!(await runFilter(node, plugins))) {
    node.filtered = true;
    return [];
  }

  if (cache) {
    const cached = cache.entries[node.notionId];
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

  // Reserve sibling slugs deterministically in Notion's declaration order.
  // Pages first (matches block order roughly), then databases — both share
  // the same `childDir` namespace so we walk the merged sequence in original
  // block order to keep things predictable.
  const children: PageNode[] = [];
  const orderedChildren = orderChildBlocksFromPage(retrieved.blocks);
  for (const block of orderedChildren) {
    if (block.type === "child_page") {
      const childTitle = block.child_page.title;
      const resolvedTitle = reserveSiblingSlug(
        childTitle,
        childDir,
        usedSlugsByDir,
        logger,
        block.id,
      );
      const newNode = makePageNode({
        notionId: block.id,
        notionTitle: childTitle,
        parentNode: node,
        childPageBlock: block,
        resolvedTitle,
      });
      node.childNodes.push(newNode);
      children.push(newNode);
    } else {
      // child_database block — becomes a wiki node. The block's title is a
      // plain string (TitleObjectResponse), not rich text.
      const childTitle = block.child_database.title || "Untitled database";
      const resolvedTitle = reserveSiblingSlug(
        childTitle,
        childDir,
        usedSlugsByDir,
        logger,
        block.id,
      );
      const newNode = makeWikiNode({
        notionId: block.id,
        notionTitle: childTitle,
        parentNode: node,
        childDatabaseBlock: block,
        resolvedTitle,
      });
      node.childNodes.push(newNode);
      children.push(newNode);
    }
  }
  return children;
}

/**
 * Visits a wiki node: retrieve the database, query every item across its
 * data source(s), build a parent-id → children map, and synthesize the tree
 * underneath in one pass. Items' content is fetched lazily when each item is
 * later visited by the worker pool (which dispatches them as page nodes).
 *
 * Wiki nodes are directory-only — they own `childDir` but have no
 * `filePath`. The Generator naturally skips them when writing files.
 */
async function visitWiki(
  node: PageNode,
  notion: NotionParser,
  contentDir: string,
  fileExtension: string,
  plugins: Plugin[],
  usedSlugsByDir: Map<string, Set<string>>,
  logger: Logger | undefined,
): Promise<PageNode[]> {
  const retrieved = await notion.retrieveDatabase(node.notionId);
  node.database = retrieved.database;
  node.lastEditedTime = retrieved.database.last_edited_time;
  node.icon = retrieved.database.icon;
  node.databaseTitle = plainTextFromTitle(retrieved.database.title);
  node.databaseDescription = plainTextFromTitle(retrieved.database.description);

  if (node.parentNode === null && node.databaseTitle) {
    node.notionTitle = node.databaseTitle;
  }

  // Wiki nodes are directory-only — childDir is set, filePath stays undefined.
  const parentDir = node.parentNode?.childDir ?? contentDir;
  const titleForPath = node.resolvedTitle ?? node.notionTitle;
  const { childDir } = computeNodeFilePath(
    titleForPath,
    parentDir,
    true /* hasChildren — wiki always represents a directory */,
    fileExtension,
  );
  node.childDir = childDir;

  if (!(await runFilter(node, plugins))) {
    node.filtered = true;
    return [];
  }

  // Build a parent-id → child-pages map from the flat query result.
  // Top-level items: parent.type === "data_source_id" matching one of the
  // database's data sources, OR parent.type === "database_id" matching the
  // database id (some older fixtures use this shape).
  // Nested items: parent.type === "page_id" pointing at another item.
  const dataSourceIds = new Set(retrieved.database.data_sources.map((d) => d.id));
  const databaseId = retrieved.database.id;
  const childrenByParent = new Map<string, PageObjectResponse[]>();
  const topLevel: PageObjectResponse[] = [];

  for (const item of retrieved.items) {
    const parent = item.parent;
    if (
      (parent.type === "data_source_id" &&
        dataSourceIds.has(parent.data_source_id)) ||
      (parent.type === "database_id" && parent.database_id === databaseId)
    ) {
      topLevel.push(item);
    } else if (parent.type === "page_id") {
      const list = childrenByParent.get(parent.page_id) ?? [];
      list.push(item);
      childrenByParent.set(parent.page_id, list);
    } else {
      // Item's parent isn't this database or any sibling — surface as
      // top-level so it doesn't get silently dropped.
      topLevel.push(item);
    }
  }

  const enqueued: PageNode[] = [];
  // Recursively materialize the subtree from the parent map. Each wiki item
  // becomes a `kind: "page"` node whose `notionId` is the item's page id and
  // whose `childPageBlock` is null (it was discovered via the database
  // query, not a block).
  const buildSubtree = (
    items: PageObjectResponse[],
    parentNode: PageNode,
    parentChildDir: string,
  ) => {
    for (const item of items) {
      const title = extractPageTitle(item) ?? "Untitled";
      const resolvedTitle = reserveSiblingSlug(
        title,
        parentChildDir,
        usedSlugsByDir,
        logger,
        item.id,
      );
      const itemNode = makePageNode({
        notionId: item.id,
        notionTitle: title,
        parentNode,
        childPageBlock: null,
        resolvedTitle,
      });
      // Pre-populate the page object so the page-visit only needs to fetch
      // blocks for content. Properties / icon / last_edited_time come from
      // the query result with no extra round-trip.
      itemNode.page = item;
      itemNode.properties = item.properties;
      itemNode.icon = item.icon;
      itemNode.lastEditedTime = item.last_edited_time;
      parentNode.childNodes.push(itemNode);
      enqueued.push(itemNode);

      const subItems = childrenByParent.get(item.id) ?? [];
      if (subItems.length > 0) {
        // Resolve the item's own childDir before recursing into its children
        // so nested slugs can reserve correctly.
        const { childDir: itemChildDir } = computeNodeFilePath(
          resolvedTitle,
          parentChildDir,
          true,
          fileExtension,
        );
        itemNode.childDir = itemChildDir;
        buildSubtree(subItems, itemNode, itemChildDir);
      }
    }
  };
  buildSubtree(topLevel, node, childDir);

  return enqueued;
}

/**
 * Orders a page's children (child_page + child_database) by their original
 * appearance in the block list. Keeping document order is the most natural
 * choice for an author who wants control over sibling ordering.
 */
function orderChildBlocksFromPage(
  blocks: BlockObjectResponse[],
): Array<ChildPageBlockObjectResponse | ChildDatabaseBlockObjectResponse> {
  const out: Array<
    ChildPageBlockObjectResponse | ChildDatabaseBlockObjectResponse
  > = [];
  for (const b of blocks) {
    if (b.type === "child_page" || b.type === "child_database") out.push(b);
  }
  return out;
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

function plainTextFromTitle(
  rich: { plain_text: string }[] | undefined,
): string {
  if (!rich) return "";
  return rich.map((r) => r.plain_text).join("");
}
