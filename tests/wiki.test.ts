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
    };

    const stats = await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Wiki root is directory-only; two items written.
    assert.equal(stats.written, 2);

    // Roots use the synthetic "Root" name for path resolution by convention.
    const wikiDir = path.join(dir, "root");
    assert.ok(fs.statSync(wikiDir).isDirectory(), "wiki dir created");
    // No auto-index — the wiki has no own file.
    assert.equal(fs.existsSync(path.join(wikiDir, "index.md")), false);
    assert.equal(
      fs.readFileSync(path.join(wikiDir, "getting-started.md"), "utf-8"),
      "# getting started",
    );
    assert.equal(
      fs.readFileSync(path.join(wikiDir, "reference.md"), "utf-8"),
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
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Parent has a child, so it becomes a directory with index.md.
    const wikiDir = path.join(dir, "root");
    assert.ok(
      fs.existsSync(path.join(wikiDir, "parent", "index.md")),
      "parent item rendered as directory index",
    );
    assert.ok(
      fs.existsSync(path.join(wikiDir, "parent", "child.md")),
      "child rendered as leaf inside parent dir",
    );
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
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Root has a child_database, so root is a directory with index.md plus a
    // nested wiki directory holding the wiki item. Root uses synthetic "root"
    // name by convention.
    assert.ok(fs.existsSync(path.join(dir, "root", "index.md")));
    assert.ok(
      fs.existsSync(path.join(dir, "root", "inner-wiki", "wiki-leaf.md")),
      "wiki nested inside regular page produces directory + leaf",
    );
    assert.equal(
      fs.existsSync(path.join(dir, "root", "inner-wiki", "index.md")),
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
    assert.ok(fs.existsSync(path.join(docsDir, "root.md")));
    assert.ok(fs.existsSync(path.join(wikiDir, "root", "item.md")));
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
    assert.equal(fs.existsSync(path.join(dir, "root")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
