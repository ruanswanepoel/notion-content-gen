import fs from "fs";
import type { NotionParser } from "./notion_parser.js";
import type { BlockChildrenResponseExtended, Plugin } from "./types.js";
import type { CacheData } from "./cache.js";
import { computeNodeFilePath } from "./util.js";

/**
 * Represents a notion page (content node) with its own content, metadata, and sub-pages.
 */
export type PageNode = {
  notionId: string;
  notionTitle: string;
  notionPage:
    | ({ metadata?: BlockChildrenResponseExtended } & Partial<
        Awaited<ReturnType<typeof NotionParser.prototype.retrievePage>>
      >)
    | null;
  parentNode: PageNode | null;
  childNodes: PageNode[];
  /** Resolved output path for this node's file, computed during tree build. */
  filePath?: string;
  /** Directory where this node's children will be written. */
  childDir?: string;
  /** True when the page matches the cache and the existing output file is reusable. */
  unchanged?: boolean;
};

export type BuildPageTreeOptions = {
  cache?: CacheData | undefined;
  contentDir: string;
  fileExtension: string;
  plugins?: Plugin[];
};

/**
 * Builds the page/node tree according to the layout in Notion, starting from the given root page ID.
 *
 * When a cache is provided, each node is first fetched without markdown
 * conversion. If the page's `last_edited_time` and resolved output path match
 * the cache and the existing file is still on disk, the node is marked
 * `unchanged` so the Generator can skip writing it. Otherwise the markdown is
 * converted in-place so the rest of the pipeline behaves as before.
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
  const { cache, contentDir, fileExtension, plugins = [] } = options;

  const rootNode: PageNode = {
    notionId: rootId,
    notionTitle: "Root",
    notionPage: null,
    parentNode: null,
    childNodes: [],
  };
  let queue = [rootNode];

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!; // Current node, never undefined

    try {
      const retrievedPage = await notion.retrievePage(node.notionId, {
        skipMarkdown: !!cache,
      });
      node.notionPage = {
        ...node.notionPage, // Preserve existing metadata
        ...retrievedPage,
      };

      // Resolve the output path so we can both consult and update the cache.
      const parentDir = node.parentNode?.childDir ?? contentDir;
      const hasChildren = retrievedPage.childPages.length > 0;
      const { filePath, childDir } = computeNodeFilePath(
        node.notionTitle,
        parentDir,
        hasChildren,
        fileExtension,
      );
      node.filePath = filePath;
      node.childDir = childDir;

      if (cache) {
        const cached = cache.pages[node.notionId];
        const unchanged =
          !!cached &&
          cached.lastEditedTime === retrievedPage.page.last_edited_time &&
          cached.filePath === filePath &&
          fs.existsSync(filePath);
        node.unchanged = unchanged;

        // The markdown was skipped during retrieval — convert it now unless
        // the file is reusable as-is.
        if (!unchanged) {
          node.notionPage.mdString = await notion.convertBlocksToMarkdown(
            retrievedPage.blocks.results,
          );
        }
      }

      if (!node.notionPage?.childPages) continue;

      for (let cp of node.notionPage?.childPages) {
        const newNode: PageNode = {
          notionId: cp.id,
          notionTitle: cp.child_page.title,
          notionPage: {
            metadata: cp,
          },
          parentNode: node,
          childNodes: [],
        };
        node.childNodes.push(newNode);
        queue.push(newNode);
      }
    } catch (err) {
      if (node.parentNode && (await runOnError(err, node, plugins))) {
        node.parentNode.childNodes = node.parentNode.childNodes.filter(
          (c) => c !== node,
        );
        continue;
      }
      throw err;
    }
  }

  return rootNode;
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
