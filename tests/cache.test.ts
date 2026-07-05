import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { buildPageTree } from "../src/page_node.js";
import { Generator } from "../src/generator.js";
import { emptyCache, type CacheRoot } from "../src/cache.js";
import { FakeNotionParser, asNotionParser, mkTmpDir } from "./fakes.js";

test("cache hit: unchanged page is skipped and not rewritten", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# original", children: [] },
    ]);

    // Seed the cache and pre-write the file as if a prior run produced it.
    const filePath = path.join(dir, "root.md");
    fs.writeFileSync(filePath, "PRESERVED CONTENT");
    const cache: CacheRoot = {
      entries: {
        root: {
          lastEditedTime: "2025-01-01T00:00:00.000Z",
          filePath,
        },
      },
    };

    const tree = await buildPageTree("root", asNotionParser(fake), {
      cache,
      contentDir: dir,
      fileExtension: "md",
      plugins: [],
    });

    const gen = new Generator({ plugins: [] });
    await gen.run(tree, dir);

    assert.equal(fs.readFileSync(filePath, "utf-8"), "PRESERVED CONTENT");
    assert.equal(gen.stats.skipped, 1);
    assert.equal(gen.stats.written, 0);
    assert.equal(fake.convertCalls, 0, "no md conversion on cache hit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache miss: changed last_edited_time triggers rewrite", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      {
        id: "root",
        title: "Root",
        markdown: "# fresh",
        children: [],
        lastEditedTime: "2025-02-01T00:00:00.000Z",
      },
    ]);

    const filePath = path.join(dir, "root.md");
    fs.writeFileSync(filePath, "STALE");
    const cache: CacheRoot = {
      entries: {
        root: {
          lastEditedTime: "2025-01-01T00:00:00.000Z",
          filePath,
        },
      },
    };

    const tree = await buildPageTree("root", asNotionParser(fake), {
      cache,
      contentDir: dir,
      fileExtension: "md",
    });
    const gen = new Generator({});
    await gen.run(tree, dir);

    assert.equal(fs.readFileSync(filePath, "utf-8"), "# fresh");
    assert.equal(gen.stats.updated, 1);
    assert.equal(gen.stats.skipped, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache miss: missing output file triggers rewrite even if time matches", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# fresh", children: [] },
    ]);

    const filePath = path.join(dir, "root.md");
    const cache: CacheRoot = {
      entries: {
        root: {
          lastEditedTime: "2025-01-01T00:00:00.000Z",
          filePath,
        },
      },
    };

    const tree = await buildPageTree("root", asNotionParser(fake), {
      cache,
      contentDir: dir,
      fileExtension: "md",
    });
    const gen = new Generator({});
    await gen.run(tree, dir);

    assert.equal(fs.readFileSync(filePath, "utf-8"), "# fresh");
    assert.equal(gen.stats.created, 1);
    assert.equal(gen.stats.skipped, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache disabled: every page is converted and written", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# r", children: ["a"] },
      { id: "a", title: "A", markdown: "# a", children: [] },
    ]);

    const tree = await buildPageTree("root", asNotionParser(fake), {
      cache: undefined,
      contentDir: dir,
      fileExtension: "md",
    });
    const gen = new Generator({});
    await gen.run(tree, dir);

    assert.equal(gen.stats.skipped, 0);
    assert.equal(gen.stats.written, 2);
    assert.ok(gen.newCache.entries.root, "cache builds even when not loaded");
    assert.ok(gen.newCache.entries.a);
    // emptyCache() helper now keyed by root
    assert.equal(emptyCache().version, 2);
    assert.deepEqual(emptyCache().roots, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
