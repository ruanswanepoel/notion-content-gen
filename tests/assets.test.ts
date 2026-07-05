import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { assetsPlugin } from "../src/plugins/assets.js";
import { Logger } from "../src/logger.js";
import type { NotionParser } from "../src/notion_parser.js";
import type { PageNode } from "../src/page_node.js";
import type { Plugin, SetupContext } from "../src/types.js";
import { mkTmpDir } from "./fakes.js";

type Transformer = (block: unknown) => Promise<string | false> | string | false;

/**
 * Captures the custom transformers a plugin registers in `setup`, standing in
 * for `notion-to-md` (the fake NotionParser doesn't run n2m). Returns the
 * registry plus a spied `fetch` so tests can assert on downloads.
 */
function setupPlugin(plugin: Plugin, dryRun = false) {
  const transformers = new Map<string, Transformer>();
  const notion = {
    n2m: {
      setCustomTransformer(type: string, fn: Transformer) {
        transformers.set(type, fn);
        return notion.n2m;
      },
    },
  } as unknown as NotionParser;

  const ctx: SetupContext = {
    notion,
    dryRun,
    logger: new Logger({ level: "silent" }),
  };
  return { transformers, ctx };
}

const NOTION_URL =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/abc-123/pic.png?X-Amz-Signature=deadbeef&X-Amz-Expires=3600";

function imageBlock(
  id: string,
  url: string,
  opts: { external?: boolean; caption?: string } = {},
): unknown {
  const caption = opts.caption
    ? [{ type: "text", plain_text: opts.caption }]
    : [];
  const inner = opts.external
    ? { type: "external", external: { url }, caption }
    : { type: "file", file: { url, expiry_time: "2099-01-01T00:00:00.000Z" }, caption };
  return { object: "block", id, type: "image", image: inner };
}

function fileBlock(id: string, url: string, name: string): unknown {
  return {
    object: "block",
    id,
    type: "file",
    file: {
      type: "file",
      file: { url, expiry_time: "2099-01-01T00:00:00.000Z" },
      caption: [],
      name,
    },
  };
}

/** Installs a fake `globalThis.fetch` returning canned bytes; returns call log. */
function mockFetch(bytes = Buffer.from("PNGDATA")) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("transformer rewrites an image block to the public path and downloads once", async () => {
  const outputDir = mkTmpDir();
  const { calls, restore } = mockFetch();
  try {
    const plugin = assetsPlugin({ outputDir, publicPath: "/notion-assets" });
    const { transformers, ctx } = setupPlugin(plugin);
    await plugin.hooks!.setup!(ctx);

    const img = transformers.get("image")!;
    const out = await img(imageBlock("11111111-2222-3333-4444-555555555555", NOTION_URL));

    assert.equal(out, "![](/notion-assets/11111111222233334444555555555555.png)");
    // The asset landed on disk under its stable block-id-derived name.
    const expected = path.join(outputDir, "11111111222233334444555555555555.png");
    assert.ok(fs.existsSync(expected), "asset file written");
    assert.equal(calls.length, 1, "fetched exactly once");
  } finally {
    restore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("stable filename → a fresh run with the asset already on disk skips the download", async () => {
  const outputDir = mkTmpDir();
  const { calls, restore } = mockFetch();
  try {
    const block = imageBlock("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", NOTION_URL);

    // First run downloads.
    const p1 = assetsPlugin({ outputDir, publicPath: "/a" });
    const s1 = setupPlugin(p1);
    await p1.hooks!.setup!(s1.ctx);
    await s1.transformers.get("image")!(block);
    assert.equal(calls.length, 1);

    // Second, independent run (fresh downloader) sees the file on disk.
    const p2 = assetsPlugin({ outputDir, publicPath: "/a" });
    const s2 = setupPlugin(p2);
    await p2.hooks!.setup!(s2.ctx);
    const out = await s2.transformers.get("image")!(block);

    assert.equal(calls.length, 1, "no second download");
    assert.equal(out, "![](/a/aaaaaaaabbbbccccddddeeeeeeeeeeee.png)");
  } finally {
    restore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("dry-run rewrites the reference but writes nothing", async () => {
  const outputDir = mkTmpDir();
  const { calls, restore } = mockFetch();
  try {
    const plugin = assetsPlugin({ outputDir, publicPath: "/x" });
    const { transformers, ctx } = setupPlugin(plugin, /* dryRun */ true);
    await plugin.hooks!.setup!(ctx);

    const out = await transformers.get("image")!(
      imageBlock("dddddddd-0000-0000-0000-000000000000", NOTION_URL),
    );

    assert.equal(out, "![](/x/dddddddd000000000000000000000000.png)");
    assert.equal(calls.length, 0, "no network in dry-run");
    assert.equal(fs.readdirSync(outputDir).length, 0, "no files written");
  } finally {
    restore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("includeExternal:false leaves external URLs untouched (transformer returns false)", async () => {
  const outputDir = mkTmpDir();
  const { calls, restore } = mockFetch();
  try {
    const plugin = assetsPlugin({ outputDir, publicPath: "/x" });
    const { transformers, ctx } = setupPlugin(plugin);
    await plugin.hooks!.setup!(ctx);

    const out = await transformers.get("image")!(
      imageBlock("ext", "https://example.com/logo.svg", { external: true }),
    );

    assert.equal(out, false, "external falls back to n2m default");
    assert.equal(calls.length, 0);

    // With includeExternal:true it downloads instead.
    const plugin2 = assetsPlugin({ outputDir, publicPath: "/x", includeExternal: true });
    const s2 = setupPlugin(plugin2);
    await plugin2.hooks!.setup!(s2.ctx);
    const out2 = await s2.transformers.get("image")!(
      imageBlock("ext2", "https://example.com/logo.svg", { external: true }),
    );
    assert.equal(out2, "![](/x/ext2.svg)");
    assert.equal(calls.length, 1);
  } finally {
    restore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("naming:'original' de-dupes filename collisions with a block-id fragment", async () => {
  const outputDir = mkTmpDir();
  const { restore } = mockFetch();
  try {
    const url = "https://prod-files-secure.s3.amazonaws.com/x/diagram.png?sig=1";
    const plugin = assetsPlugin({ outputDir, publicPath: "/m", naming: "original" });
    const { transformers, ctx } = setupPlugin(plugin);
    await plugin.hooks!.setup!(ctx);
    const img = transformers.get("image")!;

    const first = await img(imageBlock("11111111aaaa", url));
    const second = await img(imageBlock("22222222bbbb", url));

    assert.equal(first, "![](/m/diagram.png)");
    assert.notEqual(second, first, "second asset gets a distinct name");
    assert.match(second as string, /^!\[\]\(\/m\/diagram-22222222.*\.png\)$/);
    // Both distinct files exist on disk.
    assert.ok(fs.existsSync(path.join(outputDir, "diagram.png")));
    assert.equal(fs.readdirSync(outputDir).length, 2);
  } finally {
    restore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("relative mode: transform hook resolves the marker against the page's output file", async () => {
  const { restore } = mockFetch();
  try {
    // No publicPath → relative mode. A fixed outputDir keeps the relative
    // computation deterministic regardless of cwd; dry-run keeps the test from
    // writing bytes into the repo (the marker is still produced in dry-run).
    const plugin = assetsPlugin({ outputDir: "public/notion-assets" });
    const { transformers, ctx } = setupPlugin(plugin, /* dryRun */ true);
    await plugin.hooks!.setup!(ctx);

    const marker = await transformers.get("image")!(
      imageBlock("cccccccc-0000-0000-0000-000000000000", NOTION_URL),
    );
    assert.match(marker as string, /^!\[\]\(%%NCG_ASSET:cccccccc000000000000000000000000\.png%%\)$/);

    // The transform hook rewrites the marker to a page-relative path.
    const node = { filePath: "content/docs/guide.md" } as PageNode;
    const resolved = await plugin.hooks!.transform!(marker as string, node);
    assert.equal(
      resolved,
      "![](../../public/notion-assets/cccccccc000000000000000000000000.png)",
    );
  } finally {
    restore();
  }
});

test("file block uses its caption/name as the link label", async () => {
  const outputDir = mkTmpDir();
  const { restore } = mockFetch();
  try {
    const plugin = assetsPlugin({ outputDir, publicPath: "/f" });
    const { transformers, ctx } = setupPlugin(plugin);
    await plugin.hooks!.setup!(ctx);

    const url = "https://prod-files-secure.s3.amazonaws.com/x/report.pdf?sig=1";
    const out = await transformers.get("file")!(
      fileBlock("ffffffff0000", url, "Q3 Report.pdf"),
    );
    assert.equal(out, "[Q3 Report.pdf](/f/ffffffff0000.pdf)");
  } finally {
    restore();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
