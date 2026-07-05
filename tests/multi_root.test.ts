import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { generate } from "../src/index.js";
import { Logger } from "../src/logger.js";
import type { Config } from "../src/types.js";
import { ConfigSchema } from "../src/types.js";
import { FakeNotionParser, asNotionParser, mkTmpDir } from "./fakes.js";

function silentLogger() {
  return new Logger({ level: "silent" });
}

test("multi-root: each root writes to its own contentDir", async () => {
  const root1 = mkTmpDir();
  const root2 = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "docs", title: "Docs", markdown: "# docs", children: [] },
      { id: "blog", title: "Blog", markdown: "# blog", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      contentDir: "default",
      fileExtension: "md",
      cache: false,
      cleanup: true,
      concurrency: 4,
      roots: [
        { notionPageId: "docs", contentDir: root1 },
        { notionPageId: "blog", contentDir: root2 },
      ],
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    assert.equal(stats.written, 2);
    // Root nodes use the synthetic "Root" name for path resolution by
    // convention, regardless of the real title (which is preserved on the
    // node for plugins). The contentDir is what disambiguates roots.
    assert.equal(fs.readFileSync(path.join(root1, "root.md"), "utf-8"), "# docs");
    assert.equal(fs.readFileSync(path.join(root2, "root.md"), "utf-8"), "# blog");
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test("multi-root: cache is keyed by rootId; per-root cache hit/miss is independent", async () => {
  const dir1 = mkTmpDir();
  const dir2 = mkTmpDir();
  const cacheDir = mkTmpDir();
  const cachePath = path.join(cacheDir, "cache.json");
  try {
    const fake = new FakeNotionParser([
      { id: "a", title: "A", markdown: "# a", children: [] },
      { id: "b", title: "B", markdown: "# b", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: cachePath,
      cleanup: true,
      concurrency: 4,
      roots: [
        { notionPageId: "a", contentDir: dir1 },
        { notionPageId: "b", contentDir: dir2 },
      ],
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Second run: nothing changed → both roots should be "unchanged".
    const stats2 = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.equal(stats2.skipped, 2);
    assert.equal(stats2.written, 0);

    // Bump only root A's lastEditedTime → only root A should rebuild.
    fake.pages.get("a")!.lastEditedTime = "2025-09-09T00:00:00.000Z";
    const stats3 = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.equal(stats3.skipped, 1, "root B remained unchanged");
    assert.equal(stats3.updated, 1, "root A was rewritten");
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("multi-root: cleanup is scoped per-root", async () => {
  const dir1 = mkTmpDir();
  const dir2 = mkTmpDir();
  const cacheDir = mkTmpDir();
  const cachePath = path.join(cacheDir, "cache.json");
  try {
    const fake = new FakeNotionParser([
      { id: "a-root", title: "A", markdown: "# a", children: ["a-leaf"] },
      { id: "a-leaf", title: "Leaf-A", markdown: "# leaf-a", children: [] },
      { id: "b-root", title: "B", markdown: "# b", children: ["b-leaf"] },
      { id: "b-leaf", title: "Leaf-B", markdown: "# leaf-b", children: [] },
    ]);
    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: cachePath,
      cleanup: true,
      concurrency: 4,
      roots: [
        { notionPageId: "a-root", contentDir: dir1 },
        { notionPageId: "b-root", contentDir: dir2 },
      ],
    };
    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    const aLeafPath = path.join(dir1, "root", "leaf-a.md");
    const bLeafPath = path.join(dir2, "root", "leaf-b.md");
    assert.ok(fs.existsSync(aLeafPath));
    assert.ok(fs.existsSync(bLeafPath));

    // Second run: drop A's leaf only. B's tree is untouched.
    fake.pages.get("a-root")!.children = [];
    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    assert.equal(fs.existsSync(aLeafPath), false, "a-leaf cleaned up");
    assert.ok(fs.existsSync(bLeafPath), "b-leaf untouched by A's cleanup");
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("multi-root: setup fires once, beforeAll/afterAll fire per root", async () => {
  const dir1 = mkTmpDir();
  const dir2 = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "a", title: "A", markdown: "# a", children: [] },
      { id: "b", title: "B", markdown: "# b", children: [] },
    ]);

    let setupCalls = 0;
    const beforeAllRoots: string[] = [];
    const afterAllRoots: string[] = [];
    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      roots: [
        { notionPageId: "a", contentDir: dir1 },
        { notionPageId: "b", contentDir: dir2 },
      ],
      plugins: [
        {
          name: "lifecycle",
          hooks: {
            setup: () => {
              setupCalls++;
            },
            beforeAll: (tree) => {
              beforeAllRoots.push(tree.notionId);
            },
            afterAll: (tree) => {
              afterAllRoots.push(tree.notionId);
            },
          },
        },
      ],
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    assert.equal(setupCalls, 1, "setup fires once for the whole run");
    assert.deepEqual(beforeAllRoots, ["a", "b"], "beforeAll fires per root");
    assert.deepEqual(afterAllRoots, ["a", "b"], "afterAll fires per root");
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test("multi-root: single-root legacy form still works", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# r", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      notionPageId: "root",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: true,
      concurrency: 4,
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.equal(stats.written, 1);
    assert.equal(fs.readFileSync(path.join(dir, "root.md"), "utf-8"), "# r");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-root: per-root fileExtension overrides the top-level default", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "page", title: "Page", markdown: "x", children: [] },
    ]);
    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      roots: [{ notionPageId: "page", contentDir: dir, fileExtension: "mdx" }],
    };
    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.ok(fs.existsSync(path.join(dir, "root.mdx")));
    assert.ok(!fs.existsSync(path.join(dir, "root.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ConfigSchema: rejects both notionPageId and roots", () => {
  const result = ConfigSchema.safeParse({
    notionToken: "fake",
    notionPageId: "x",
    roots: [{ notionPageId: "y" }],
  });
  assert.equal(result.success, false);
});

test("ConfigSchema: rejects empty configs (no notionPageId, no roots)", () => {
  const result = ConfigSchema.safeParse({ notionToken: "fake" });
  assert.equal(result.success, false);
});

test("ConfigSchema: accepts a non-empty roots array without notionPageId", () => {
  const result = ConfigSchema.safeParse({
    notionToken: "fake",
    roots: [{ notionPageId: "x" }],
  });
  assert.equal(result.success, true);
});
