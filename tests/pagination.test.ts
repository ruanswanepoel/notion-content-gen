import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionParser } from "../src/notion_parser.js";

test("listAllBlockChildren consumes every cursor page", async () => {
  const parser = new NotionParser("fake-token");

  // Build three fake pages with has_more chaining.
  const page1 = {
    type: "block",
    block: {},
    object: "list",
    has_more: true,
    next_cursor: "c1",
    results: makeBlocks(0, 100),
  };
  const page2 = {
    type: "block",
    block: {},
    object: "list",
    has_more: true,
    next_cursor: "c2",
    results: makeBlocks(100, 100),
  };
  const page3 = {
    type: "block",
    block: {},
    object: "list",
    has_more: false,
    next_cursor: null,
    results: makeBlocks(200, 50),
  };

  const calls: Array<{ start_cursor: string | undefined }> = [];
  // Replace the SDK client with a stub that walks the three responses above.
  (parser as unknown as {
    notionClient: {
      blocks: {
        children: {
          list: (p: { block_id: string; start_cursor?: string }) => Promise<unknown>;
        };
      };
    };
  }).notionClient = {
    blocks: {
      children: {
        list: async (p) => {
          calls.push({ start_cursor: p.start_cursor });
          if (!p.start_cursor) return page1;
          if (p.start_cursor === "c1") return page2;
          if (p.start_cursor === "c2") return page3;
          throw new Error(`unexpected cursor ${p.start_cursor}`);
        },
      },
    },
  };

  const all = await parser.listAllBlockChildren("root");
  assert.equal(all.length, 250, "all three pages concatenated");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.start_cursor, undefined);
  assert.equal(calls[1]?.start_cursor, "c1");
  assert.equal(calls[2]?.start_cursor, "c2");
});

/** Generate `n` minimal child_page blocks starting from id `${start}`. */
function makeBlocks(start: number, n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      object: "block",
      id: `b-${start + i}`,
      parent: { type: "page_id", page_id: "root" },
      created_time: "2025-01-01T00:00:00.000Z",
      last_edited_time: "2025-01-01T00:00:00.000Z",
      created_by: { object: "user", id: "u" },
      last_edited_by: { object: "user", id: "u" },
      has_children: false,
      archived: false,
      in_trash: false,
      type: "paragraph",
      paragraph: { rich_text: [], color: "default" },
    });
  }
  return out;
}
