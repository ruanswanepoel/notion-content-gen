import { retrievePage } from "./notion.js";
import type { BlockChildrenResponseExtended } from "./types.js";

export type Node = {
  notionId: string;
  notionTitle: string;
  notionPage:
    | ({ metadata?: BlockChildrenResponseExtended } & Partial<
        Awaited<ReturnType<typeof retrievePage>>
      >)
    | null;
  parentNode: Node | null;
  childNodes: Node[];
};

export async function buildPageTree(rootId: string) {
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
    const retrievedPage = await retrievePage(node.notionId);
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
