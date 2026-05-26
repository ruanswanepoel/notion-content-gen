import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  cleanupStaleFiles,
  emptyCache,
  type CacheData,
} from "../src/cache.js";
import { mkTmpDir } from "./fakes.js";

test("cleanupStaleFiles removes files no longer claimed by the new cache", () => {
  const dir = mkTmpDir();
  try {
    const stale = path.join(dir, "removed.md");
    const kept = path.join(dir, "kept.md");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(kept, "y");

    const oldCache: CacheData = {
      version: 1,
      pages: {
        a: { lastEditedTime: "t", filePath: stale },
        b: { lastEditedTime: "t", filePath: kept },
      },
    };
    const newCache: CacheData = {
      version: 1,
      pages: {
        b: { lastEditedTime: "t", filePath: kept },
      },
    };

    const result = cleanupStaleFiles(oldCache, newCache, { contentDir: dir });
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(kept), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupStaleFiles only touches paths the old cache claimed", () => {
  const dir = mkTmpDir();
  try {
    const tracked = path.join(dir, "tracked.md");
    const untracked = path.join(dir, "untracked.md");
    fs.writeFileSync(tracked, "x");
    fs.writeFileSync(untracked, "y");

    const oldCache: CacheData = {
      version: 1,
      pages: { a: { lastEditedTime: "t", filePath: tracked } },
    };
    const newCache = emptyCache();

    const result = cleanupStaleFiles(oldCache, newCache, { contentDir: dir });
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(tracked), false);
    assert.equal(fs.existsSync(untracked), true, "untracked file preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupStaleFiles refuses to escape contentDir", () => {
  const root = mkTmpDir();
  const dir = path.join(root, "content");
  fs.mkdirSync(dir);
  try {
    const escapedPath = path.join(root, "outside.md");
    fs.writeFileSync(escapedPath, "do not touch");

    const oldCache: CacheData = {
      version: 1,
      pages: { a: { lastEditedTime: "t", filePath: escapedPath } },
    };
    const newCache = emptyCache();

    const result = cleanupStaleFiles(oldCache, newCache, { contentDir: dir });
    assert.equal(result.skipped.length, 1);
    assert.equal(fs.existsSync(escapedPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupStaleFiles prunes emptied directories but never contentDir", () => {
  const dir = mkTmpDir();
  try {
    const subdir = path.join(dir, "deep", "nested");
    fs.mkdirSync(subdir, { recursive: true });
    const leaf = path.join(subdir, "x.md");
    fs.writeFileSync(leaf, "x");

    const oldCache: CacheData = {
      version: 1,
      pages: { a: { lastEditedTime: "t", filePath: leaf } },
    };
    cleanupStaleFiles(oldCache, emptyCache(), { contentDir: dir });

    assert.equal(fs.existsSync(leaf), false);
    assert.equal(fs.existsSync(subdir), false);
    assert.equal(fs.existsSync(path.join(dir, "deep")), false);
    assert.equal(fs.existsSync(dir), true, "contentDir itself preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupStaleFiles dry-run reports without removing", () => {
  const dir = mkTmpDir();
  try {
    const stale = path.join(dir, "stale.md");
    fs.writeFileSync(stale, "x");

    const oldCache: CacheData = {
      version: 1,
      pages: { a: { lastEditedTime: "t", filePath: stale } },
    };
    const result = cleanupStaleFiles(oldCache, emptyCache(), {
      contentDir: dir,
      dryRun: true,
    });
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(stale), true, "file preserved in dry-run");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
