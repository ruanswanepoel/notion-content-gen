import fs from "fs";
import os from "os";
import path from "path";
import type {
  BlockObjectResponse,
  ChildDatabaseBlockObjectResponse,
  ChildPageBlockObjectResponse,
  DatabaseObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import type { NotionParser } from "../src/notion_parser.js";
import type {
  NodeKind,
  RetrievedDatabase,
  RetrievedPage,
} from "../src/types.js";

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
  /** Child databases nested inside this page (in document order). */
  childDatabases?: Array<{ id: string; title: string }>;
  /** Optional last_edited_time; defaults to `"2025-01-01T00:00:00.000Z"`. */
  lastEditedTime?: string;
  /** Optional properties map merged onto the synthesized page. */
  properties?: Record<string, unknown>;
  /** Optional icon attached to the synthesized page. */
  icon?: PageObjectResponse["icon"];
  /** Custom parent reference (defaults to `{ type: "page_id", page_id: "parent" }`). */
  parent?: PageObjectResponse["parent"];
  /** When true, retrievePage throws on access — useful for error tests. */
  throws?: boolean;
};

/**
 * Fake wiki/database input. The `items` array is the flat result of a
 * `dataSources.query` — including any nested sub-pages whose `parent` is
 * another item in the list.
 */
export type FakeDatabaseInput = {
  id: string;
  title: string;
  description?: string;
  /** Notion id of the database's single data source. Defaults to `<id>-ds`. */
  dataSourceId?: string;
  /** Last edited time on the database object. */
  lastEditedTime?: string;
  /**
   * Pages in this wiki, flat. Pages with `parent: { type: "page_id", page_id: ... }`
   * pointing at another item become nested sub-pages. Pages without an
   * explicit parent are attached to the wiki root.
   */
  items: FakePageInput[];
  /**
   * Optional classification override. By default, ids registered as pages
   * classify as "page" and ids registered as databases classify as "wiki" —
   * set this to force a particular result for the classifyNode probe.
   */
  classifyAs?: NodeKind;
};

export class FakeNotionParser {
  pages = new Map<string, FakePageInput>();
  databases = new Map<string, FakeDatabaseInput>();
  retrieveCalls: string[] = [];
  databaseRetrieveCalls: string[] = [];
  dataSourceQueryCalls: string[] = [];
  classifyCalls: string[] = [];
  convertCalls = 0;

  constructor(pages: FakePageInput[], databases: FakeDatabaseInput[] = []) {
    for (const p of pages) this.pages.set(p.id, p);
    for (const d of databases) this.databases.set(d.id, d);
  }

  async classifyNode(id: string): Promise<NodeKind> {
    this.classifyCalls.push(id);
    const db = this.databases.get(id);
    if (db) return db.classifyAs ?? "wiki";
    if (this.pages.has(id)) return "page";
    throw new Error(`No fake registration for id ${id}`);
  }

  async retrieveDatabase(databaseId: string): Promise<RetrievedDatabase> {
    this.databaseRetrieveCalls.push(databaseId);
    const db = this.databases.get(databaseId);
    if (!db) throw new Error(`No fake database: ${databaseId}`);
    const dataSourceId = db.dataSourceId ?? `${databaseId}-ds`;
    this.dataSourceQueryCalls.push(dataSourceId);
    const items = db.items.map((p) => {
      // Register the item as a page so subsequent retrievePage works.
      if (!this.pages.has(p.id)) this.pages.set(p.id, p);
      return makePageObject(p.id, p);
    });
    return {
      database: makeDatabaseObject(db, dataSourceId),
      items,
    };
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

    const childDatabases: ChildDatabaseBlockObjectResponse[] = (
      p.childDatabases ?? []
    ).map((cdb) => makeChildDatabaseBlock(cdb.id, cdb.title));

    const page = makePageObject(pageId, p);
    const blocks: BlockObjectResponse[] = [...childPages, ...childDatabases];
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
      childDatabases,
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

function makeChildDatabaseBlock(
  id: string,
  title: string,
): ChildDatabaseBlockObjectResponse {
  return {
    type: "child_database",
    child_database: { title },
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
  } as ChildDatabaseBlockObjectResponse;
}

function makeDatabaseObject(
  input: FakeDatabaseInput,
  dataSourceId: string,
): DatabaseObjectResponse {
  return {
    object: "database",
    id: input.id,
    title: input.title
      ? [{ type: "text", plain_text: input.title }]
      : [],
    description: input.description
      ? [{ type: "text", plain_text: input.description }]
      : [],
    is_inline: false,
    in_trash: false,
    is_locked: false,
    created_time: "2025-01-01T00:00:00.000Z",
    last_edited_time: input.lastEditedTime ?? "2025-01-01T00:00:00.000Z",
    data_sources: [{ id: dataSourceId, name: input.title || "default" }],
    icon: null,
    cover: null,
    url: `https://notion.so/${input.id}`,
    public_url: null,
    parent: { type: "workspace", workspace: true },
  } as unknown as DatabaseObjectResponse;
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
    parent: input.parent ?? { type: "page_id", page_id: "parent" },
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
