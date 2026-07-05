import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { generate } from "../src/index.js";
import { Logger } from "../src/logger.js";
import type { Config } from "../src/types.js";
import { FakeNotionParser, asNotionParser, mkTmpDir } from "./fakes.js";

function silentLogger() {
  return new Logger({ level: "silent" });
}

test("wiki root: flat items become files in a directory; no auto-index", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "My Wiki",
          description: "A short tagline",
          items: [
            {
              id: "item-1",
              title: "Getting Started",
              markdown: "# getting started",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
            {
              id: "item-2",
              title: "Reference",
              markdown: "# reference",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki1",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Wiki root is directory-only; two items written.
    assert.equal(stats.written, 2);

    // A wiki root maps directly onto contentDir — items land there directly.
    // No auto-index — the wiki has no own file.
    assert.equal(fs.existsSync(path.join(dir, "index.md")), false);
    assert.equal(
      fs.readFileSync(path.join(dir, "getting-started.md"), "utf-8"),
      "# getting started",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "reference.md"), "utf-8"),
      "# reference",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiki root: nested wiki items reconstruct hierarchy from parent refs", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "Wiki",
          items: [
            {
              id: "parent-item",
              title: "Parent",
              markdown: "# parent",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
            {
              id: "child-item",
              title: "Child",
              markdown: "# child",
              children: [],
              parent: { type: "page_id", page_id: "parent-item" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki1",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Parent has a child, so it becomes a directory with index.md, directly
    // under contentDir (the wiki root maps onto contentDir).
    assert.ok(
      fs.existsSync(path.join(dir, "parent", "index.md")),
      "parent item rendered as directory index",
    );
    assert.ok(
      fs.existsSync(path.join(dir, "parent", "child.md")),
      "child rendered as leaf inside parent dir",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiki: sub-page appearing as both a DB row and a child_page block is not duplicated", async () => {
  const dir = mkTmpDir();
  try {
    // Real Notion returns a nested wiki entry twice: once as a data-source row
    // (parent = page_id of the parent entry) and once as a `child_page` block
    // in the parent entry's block stream. `parent-item` therefore lists
    // `child-item` in its `children` (→ child_page block) AND `child-item`
    // shows up in the flat data-source query with a page_id parent.
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "Wiki",
          items: [
            {
              id: "parent-item",
              title: "Parent",
              markdown: "# parent",
              children: ["child-item"],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
            {
              id: "child-item",
              title: "Child",
              markdown: "# child",
              children: [],
              parent: { type: "page_id", page_id: "parent-item" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki1",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    const parentDir = path.join(dir, "parent");
    // Exactly one child file — no `child-2.md` from the duplicate block.
    const files = fs
      .readdirSync(parentDir)
      .filter((f) => f !== "index.md")
      .sort();
    assert.deepEqual(files, ["child.md"]);
    assert.equal(
      fs.readFileSync(path.join(parentDir, "child.md"), "utf-8"),
      "# child",
    );
    // parent index + child leaf = 2 writes, not 3+.
    assert.equal(stats.written, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiki root: classification is auto-detected; no config flag needed", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki-id",
          title: "Wiki",
          items: [
            {
              id: "x",
              title: "X",
              markdown: "x",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki-id-ds", database_id: "wiki-id-ds-db" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki-id",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // The orchestrator probed once and detected "wiki".
    assert.deepEqual(fake.classifyCalls, ["wiki-id"]);
    assert.deepEqual(fake.databaseRetrieveCalls, ["wiki-id"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wiki: caching keyed by wiki id behaves like page cache (unchanged → skip)", async () => {
  const dir = mkTmpDir();
  const cacheDir = mkTmpDir();
  const cachePath = path.join(cacheDir, "cache.json");
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "Wiki",
          items: [
            {
              id: "a",
              title: "A",
              markdown: "# a",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki1",
      contentDir: dir,
      fileExtension: "md",
      cache: cachePath,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Second run with no changes → unchanged.
    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.equal(stats.skipped, 1);
    assert.equal(stats.written, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("wiki node carries database metadata for plugins", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "Engineering Wiki",
          description: "Internal docs",
          items: [
            {
              id: "a",
              title: "A",
              markdown: "x",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
          ],
        },
      ],
    );

    let observedDescription: string | undefined;
    let observedKind: string | undefined;
    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki1",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
      plugins: [
        {
          name: "observe",
          hooks: {
            beforeAll: (tree) => {
              observedKind = tree.kind;
              observedDescription = tree.databaseDescription;
            },
          },
        },
      ],
    };
    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    assert.equal(observedKind, "wiki");
    assert.equal(observedDescription, "Internal docs");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed: regular page with a child_database becomes a heterogeneous tree", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [
        {
          id: "root",
          title: "Docs",
          markdown: "# docs",
          children: [],
          childDatabases: [{ id: "inner-wiki", title: "Inner Wiki" }],
        },
      ],
      [
        {
          id: "inner-wiki",
          title: "Inner Wiki",
          items: [
            {
              id: "wiki-leaf",
              title: "Wiki Leaf",
              markdown: "# wiki leaf",
              children: [],
              parent: {
                type: "data_source_id",
                data_source_id: "inner-wiki-ds",
                database_id: "inner-wiki-ds-db",
              },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "root",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Root maps onto contentDir: its own body → contentDir/index.md, and the
    // nested wiki directory holding the wiki item sits directly under it.
    assert.ok(fs.existsSync(path.join(dir, "index.md")));
    assert.ok(
      fs.existsSync(path.join(dir, "inner-wiki", "wiki-leaf.md")),
      "wiki nested inside regular page produces directory + leaf",
    );
    assert.equal(
      fs.existsSync(path.join(dir, "inner-wiki", "index.md")),
      false,
      "no auto-index for nested wiki",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-root: a page root and a wiki root coexist in one run", async () => {
  const docsDir = mkTmpDir();
  const wikiDir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [{ id: "docs", title: "Docs", markdown: "# docs", children: [] }],
      [
        {
          id: "wiki1",
          title: "Wiki",
          items: [
            {
              id: "item",
              title: "Item",
              markdown: "# item",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
      roots: [
        { notionPageId: "docs", contentDir: docsDir },
        { notionPageId: "wiki1", contentDir: wikiDir },
      ],
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.equal(stats.written, 2);
    // "Docs" is a leaf root → its body writes to <contentDir>/index.md.
    assert.ok(fs.existsSync(path.join(docsDir, "index.md")));
    // Wiki root maps onto contentDir → item lands directly under it.
    assert.ok(fs.existsSync(path.join(wikiDir, "item.md")));
  } finally {
    fs.rmSync(docsDir, { recursive: true, force: true });
    fs.rmSync(wikiDir, { recursive: true, force: true });
  }
});

test("wiki filter: returning false on a wiki node skips the entire subtree", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "Skip Me",
          items: [
            {
              id: "x",
              title: "X",
              markdown: "x",
              children: [],
              parent: { type: "data_source_id", data_source_id: "wiki1-ds", database_id: "wiki1-ds-db" },
            },
          ],
        },
      ],
    );

    const config: Config = {
      notionToken: "fake",
      notionPageId: "wiki1",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false,
      plugins: [
        {
          name: "skip-wiki",
          hooks: {
            filter: (node) => node.kind !== "wiki",
          },
        },
      ],
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });
    assert.equal(stats.written, 0);
    assert.equal(stats.filtered, 1);
    // Whole wiki filtered → nothing written into contentDir.
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
