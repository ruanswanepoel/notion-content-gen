import type { Notion } from "./notion.js";
import type { BlockChildrenResponseExtended } from "./types.js";

/**
 * Represents a notion page (content node) with its own content, metadata, and sub-pages.
 */
export type Node = {
  notionId: string;
  notionTitle: string;
  notionPage:
    | ({ metadata?: BlockChildrenResponseExtended } & Partial<
        Awaited<ReturnType<typeof Notion.prototype.retrievePage>>
      >)
    | null;
  parentNode: Node | null;
  childNodes: Node[];
};

/**
 * Builds the page/node tree according to the layout in Notion, starting from the given root page ID.
 */
export async function buildPageTree(rootId: string, notion: Notion) {
  const rootNode: Node = {
    notionId: rootId,
    notionTitle: "Root",
    notionPage: null,
    parentNode: null,
    childNodes: [],
  };
  let queue = [rootNode];

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!; // Currunt node, never undefined
    const retrievedPage = await notion.retrievePage(node.notionId);
    node.notionPage = {
      ...node.notionPage, // Preserve existing metadata
      ...retrievedPage,
    };

    if (!node.notionPage?.childPages) continue;

    for (let cp of node.notionPage?.childPages) {
      const newNode = {
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
  }

  return rootNode;
}
