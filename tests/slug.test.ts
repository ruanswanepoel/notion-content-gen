import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { buildPageTree } from "../src/page_node.js";
import { Generator } from "../src/generator.js";
import { FakeNotionParser, asNotionParser, mkTmpDir } from "./fakes.js";

test("sibling slug collision: deterministic -2/-3 suffixes in Notion's child order", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", children: ["a", "b", "c"], markdown: "" },
      { id: "a", title: "Page", children: [], markdown: "# a" },
      { id: "b", title: "Page", children: [], markdown: "# b" },
      { id: "c", title: "Page", children: [], markdown: "# c" },
    ]);

    const tree = await buildPageTree("root", asNotionParser(fake), {
      contentDir: dir,
      fileExtension: "md",
    });
    const gen = new Generator({});
    await gen.run(tree, dir);

    const childDir = path.join(dir, "root");
    // index.md is the root page's own file; the three siblings sit beside it.
    const files = fs
      .readdirSync(childDir)
      .filter((f) => f !== "index.md")
      .sort();
    assert.deepEqual(files, ["page-2.md", "page-3.md", "page.md"]);
    // Notion child order: first sibling keeps the natural slug.
    assert.equal(fs.readFileSync(path.join(childDir, "page.md"), "utf-8"), "# a");
    assert.equal(fs.readFileSync(path.join(childDir, "page-2.md"), "utf-8"), "# b");
    assert.equal(fs.readFileSync(path.join(childDir, "page-3.md"), "utf-8"), "# c");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("title with extension: explicit extension used and slugified base", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", children: ["m"], markdown: "" },
      { id: "m", title: "My Meta.json", children: [], markdown: "{\"a\":1}" },
    ]);
    const tree = await buildPageTree("root", asNotionParser(fake), {
      contentDir: dir,
      fileExtension: "md",
    });
    const gen = new Generator({});
    await gen.run(tree, dir);
    assert.ok(fs.existsSync(path.join(dir, "root", "my-meta.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
