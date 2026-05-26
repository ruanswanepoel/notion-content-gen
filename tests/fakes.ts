import fs from "fs";
import os from "os";
import path from "path";
import type {
  BlockObjectResponse,
  ChildPageBlockObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import type { NotionParser } from "../src/notion_parser.js";
import type { RetrievedPage } from "../src/types.js";

/**
 * Test harness for the buildPageTree / Generator pipeline. Returns canned
 * RetrievedPage shapes by Notion page id. Lets us exercise the plugin
 * contract without ever hitting the network.
 */
export type FakePageInput = {
  id: string;
  title: string;
  /** Markdown body returned by `retrievePage` (also by re-conversion). */
  markdown?: string;
  /** Child Notion page ids, in order. */
  children?: string[];
  /** Optional last_edited_time; defaults to `"2025-01-01T00:00:00.000Z"`. */
  lastEditedTime?: string;
  /** Optional properties map merged onto the synthesized page. */
  properties?: Record<string, unknown>;
  /** Optional icon attached to the synthesized page. */
  icon?: PageObjectResponse["icon"];
  /** When true, retrievePage throws on access — useful for error tests. */
  throws?: boolean;
};

export class FakeNotionParser {
  pages = new Map<string, FakePageInput>();
  retrieveCalls: string[] = [];
  convertCalls = 0;

  constructor(pages: FakePageInput[]) {
    for (const p of pages) this.pages.set(p.id, p);
  }

  async retrievePage(
    pageId: string,
    options: { skipMarkdown?: boolean } = {},
  ): Promise<RetrievedPage> {
    this.retrieveCalls.push(pageId);
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`No fake page: ${pageId}`);
    if (p.throws) throw new Error(`Forced failure on ${pageId}`);

    const childPages: ChildPageBlockObjectResponse[] = (p.children ?? []).map(
      (cid) => {
        const child = this.pages.get(cid);
        if (!child) throw new Error(`No fake page: ${cid}`);
        return makeChildPageBlock(cid, child.title);
      },
    );

    const page = makePageObject(pageId, p);
    const blocks: BlockObjectResponse[] = [...childPages];
    // Tag the blocks array with the source page id so `convertBlocksToMarkdown`
    // can recover the right markdown later. This works because buildPageTree
    // passes the exact same array it received back to `convertBlocksToMarkdown`.
    (blocks as unknown as { __ncgPageId: string }).__ncgPageId = pageId;
    const mdString = options.skipMarkdown ? "" : (p.markdown ?? "");

    return {
      page,
      blocks,
      mdString,
      childPages,
    };
  }

  async convertBlocksToMarkdown(blocks: BlockObjectResponse[]): Promise<string> {
    this.convertCalls++;
    const pageId = (blocks as unknown as { __ncgPageId?: string }).__ncgPageId;
    if (pageId) {
      const p = this.pages.get(pageId);
      if (p) return p.markdown ?? "";
    }
    return "";
  }
}

/**
 * Cast to a `NotionParser` so we can hand it to `buildPageTree`. The shape
 * we need overlaps exactly with the methods used by the production code.
 */
export function asNotionParser(fake: FakeNotionParser): NotionParser {
  return fake as unknown as NotionParser;
}

function makeChildPageBlock(
  id: string,
  title: string,
): ChildPageBlockObjectResponse {
  return {
    type: "child_page",
    child_page: { title },
    parent: { type: "page_id", page_id: "parent" },
    object: "block",
    id,
    created_time: "2025-01-01T00:00:00.000Z",
    last_edited_time: "2025-01-01T00:00:00.000Z",
    has_children: true,
    archived: false,
    in_trash: false,
    created_by: { object: "user", id: "u" },
    last_edited_by: { object: "user", id: "u" },
  } as ChildPageBlockObjectResponse;
}

function makePageObject(id: string, input: FakePageInput): PageObjectResponse {
  const lastEditedTime = input.lastEditedTime ?? "2025-01-01T00:00:00.000Z";
  const titleProp = {
    id: "title",
    type: "title",
    title: [
      {
        type: "text",
        text: { content: input.title, link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: "default",
        },
        plain_text: input.title,
        href: null,
      },
    ],
  };
  return {
    object: "page",
    id,
    created_time: "2025-01-01T00:00:00.000Z",
    last_edited_time: lastEditedTime,
    archived: false,
    in_trash: false,
    is_locked: false,
    url: `https://notion.so/${id}`,
    public_url: null,
    parent: { type: "page_id", page_id: "parent" },
    properties: {
      ...(input.properties ?? {}),
      Name: titleProp,
    },
    icon: input.icon ?? null,
    cover: null,
    created_by: { object: "user", id: "u" },
    last_edited_by: { object: "user", id: "u" },
  } as unknown as PageObjectResponse;
}

/** Fresh temp dir per test, cleaned up by the caller. */
export function mkTmpDir(prefix = "ncg-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}
