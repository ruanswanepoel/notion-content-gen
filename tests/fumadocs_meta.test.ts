import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fumadocsPreset } from "../src/presets/fumadocs.js";
import { Logger } from "../src/logger.js";
import type { PageNode } from "../src/page_node.js";
import type { LifecycleContext } from "../src/types.js";
import { mkTmpDir } from "./fakes.js";

function silentLogger(): Logger {
  return new Logger({ level: "silent" });
}

// Minimal PageNode factory — only the fields the fumadocs meta plugin reads.
function node(init: Partial<PageNode> & { notionTitle: string }): PageNode {
  return {
    kind: "page",
    notionId: init.notionTitle,
    notionTitle: init.notionTitle,
    parentNode: init.parentNode ?? null,
    childNodes: init.childNodes ?? [],
    filePath: init.filePath,
    childDir: init.childDir,
    filtered: init.filtered,
    lastEditedTime: null,
    page: null,
  } as unknown as PageNode;
}

function metaPlugin() {
  const plugin = fumadocsPreset().find((p) => p.name === "fumadocs:meta");
  assert.ok(plugin?.hooks?.afterAll, "fumadocs:meta afterAll hook exists");
  return plugin;
}

function ctx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    dryRun: false,
    cleanup: true,
    logger: silentLogger(),
    ...overrides,
  };
}

/**
 * Builds a small on-disk tree: a published `section-a` (with one leaf page) and
 * a `section-b` that is fully drafted this run. `section-b/meta.json` already
 * exists on disk from a previous run, plus a stale root `meta.json` listing
 * both sections.
 */
function fixture(dir: string): PageNode {
  const sectionADir = path.join(dir, "section-a");
  const sectionBDir = path.join(dir, "section-b");
  fs.mkdirSync(sectionADir, { recursive: true });
  fs.mkdirSync(sectionBDir, { recursive: true });

  // Pre-existing sidecars from a prior run.
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ pages: ["section-a", "section-b"] }),
  );
  fs.writeFileSync(path.join(sectionADir, "page-a1.md"), "leaf");
  fs.writeFileSync(
    path.join(sectionBDir, "meta.json"),
    JSON.stringify({ pages: ["page-b1"] }),
  );

  const root = node({ notionTitle: "Root", childDir: dir });
  const sectionA = node({
    notionTitle: "Section A",
    parentNode: root,
    filePath: path.join(sectionADir, "index.md"),
    childDir: sectionADir,
  });
  const pageA1 = node({
    notionTitle: "Page A1",
    parentNode: sectionA,
    filePath: path.join(sectionADir, "page-a1.md"),
  });
  sectionA.childNodes = [pageA1];
  // Section B is fully drafted — filtered, so it must vanish from the sidebar.
  const sectionB = node({
    notionTitle: "Section B",
    parentNode: root,
    filePath: path.join(sectionBDir, "index.md"),
    childDir: sectionBDir,
    filtered: true,
  });
  root.childNodes = [sectionA, sectionB];
  return root;
}

test("fumadocs meta: writes sidebars for published dirs, excluding drafts", async () => {
  const dir = mkTmpDir();
  try {
    const root = fixture(dir);
    await metaPlugin()!.hooks!.afterAll!(root, ctx());

    const rootMeta = JSON.parse(
      fs.readFileSync(path.join(dir, "meta.json"), "utf-8"),
    );
    assert.deepEqual(
      rootMeta.pages,
      ["section-a"],
      "root sidebar drops the drafted section-b",
    );
    const sectionAMeta = JSON.parse(
      fs.readFileSync(path.join(dir, "section-a", "meta.json"), "utf-8"),
    );
    assert.deepEqual(sectionAMeta.pages, ["page-a1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fumadocs meta: removes orphaned meta.json and prunes the emptied dir", async () => {
  const dir = mkTmpDir();
  try {
    const root = fixture(dir);
    await metaPlugin()!.hooks!.afterAll!(root, ctx());

    assert.equal(
      fs.existsSync(path.join(dir, "section-b", "meta.json")),
      false,
      "orphaned draft sidecar removed",
    );
    assert.equal(
      fs.existsSync(path.join(dir, "section-b")),
      false,
      "directory emptied by the removal is pruned",
    );
    // Live sidecars and content are untouched; the root dir survives.
    assert.equal(fs.existsSync(path.join(dir, "meta.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "section-a", "meta.json")), true);
    assert.equal(fs.existsSync(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fumadocs meta: cleanup:false leaves orphaned sidecars in place", async () => {
  const dir = mkTmpDir();
  try {
    const root = fixture(dir);
    await metaPlugin()!.hooks!.afterAll!(root, ctx({ cleanup: false }));

    assert.equal(
      fs.existsSync(path.join(dir, "section-b", "meta.json")),
      true,
      "cleanup opt-out preserves the orphan",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fumadocs meta: dry-run writes and removes nothing", async () => {
  const dir = mkTmpDir();
  try {
    const root = fixture(dir);
    await metaPlugin()!.hooks!.afterAll!(root, ctx({ dryRun: true }));

    // Stale root meta is untouched (still lists both sections), and the
    // orphaned draft sidecar is left in place.
    const rootMeta = JSON.parse(
      fs.readFileSync(path.join(dir, "meta.json"), "utf-8"),
    );
    assert.deepEqual(rootMeta.pages, ["section-a", "section-b"]);
    assert.equal(
      fs.existsSync(path.join(dir, "section-b", "meta.json")),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
