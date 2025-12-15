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
