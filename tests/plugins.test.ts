import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { buildPageTree } from "../src/page_node.js";
import { Generator } from "../src/generator.js";
import type { Plugin } from "../src/types.js";
import { FakeNotionParser, asNotionParser, mkTmpDir } from "./fakes.js";

async function runFull(opts: {
  pages: ConstructorParameters<typeof FakeNotionParser>[0];
  plugins: Plugin[];
  dryRun?: boolean;
}) {
  const dir = mkTmpDir();
  const fake = new FakeNotionParser(opts.pages);
  const tree = await buildPageTree("root", asNotionParser(fake), {
    contentDir: dir,
    fileExtension: "md",
    plugins: opts.plugins,
  });
  const gen = new Generator({
    plugins: opts.plugins,
    dryRun: !!opts.dryRun,
  });
  await gen.run(tree, dir);
  return { dir, fake, gen, tree, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("filter short-circuit: returning false skips node and descendants pre-fetch", async () => {
  const { dir, fake, gen, cleanup } = await runFull({
    pages: [
      { id: "root", title: "Root", children: ["keep", "skip"], markdown: "# r" },
      { id: "keep", title: "Keep", children: [], markdown: "# k" },
      { id: "skip", title: "Skip", children: ["nested"], markdown: "# s" },
      { id: "nested", title: "Nested", children: [], markdown: "# n" },
    ],
    plugins: [
      {
        name: "drafts",
        hooks: {
          filter: (node) => node.notionTitle !== "Skip",
        },
      },
    ],
  });
  try {
    assert.equal(gen.stats.filtered, 1);
    assert.equal(gen.stats.written, 2);
    // Root maps onto contentDir: its body → <dir>/index.md and siblings land in <dir>.
    assert.ok(fs.existsSync(path.join(dir, "keep.md")));
    assert.ok(!fs.existsSync(path.join(dir, "skip.md")));
    assert.ok(!fs.existsSync(path.join(dir, "skip", "nested.md")));

    // The skipped page itself is fetched (the filter needs its properties),
    // but its descendants are never enqueued — `nested` should not appear.
    assert.deepEqual(fake.retrieveCalls.sort(), ["keep", "root", "skip"]);
    assert.equal(fake.retrieveCalls.includes("nested"), false);
  } finally {
    cleanup();
  }
});

test("transform chaining: each plugin sees the previous plugin's output", async () => {
  const { dir, gen, cleanup } = await runFull({
    pages: [{ id: "root", title: "Root", markdown: "body", children: [] }],
    plugins: [
      {
        name: "p1",
        hooks: { transform: (c) => `[p1]${c}` },
      },
      {
        name: "p2",
        hooks: { transform: (c) => `[p2]${c}[/p2]` },
      },
    ],
  });
  try {
    // Root is a leaf here (no children), so its body writes to <dir>/index.md.
    const content = fs.readFileSync(path.join(dir, "index.md"), "utf-8");
    assert.equal(content, "[p2][p1]body[/p2]");
    assert.equal(gen.stats.written, 1);
  } finally {
    cleanup();
  }
});

test("dry-run: no files written, no cache file produced, afterAll still runs with dryRun=true", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# r", children: [] },
    ]);
    let beforeAllCalled = false;
    let afterAllCtx: { dryRun: boolean } | null = null;
    let onFileWrittenCalled = false;
    let transformCalled = false;

    const plugin: Plugin = {
      name: "p",
      hooks: {
        beforeAll: () => {
          beforeAllCalled = true;
        },
        afterAll: (_tree, ctx) => {
          afterAllCtx = { dryRun: ctx.dryRun };
        },
        onFileWritten: () => {
          onFileWrittenCalled = true;
        },
        transform: (c) => {
          transformCalled = true;
          return c;
        },
      },
    };

    const tree = await buildPageTree("root", asNotionParser(fake), {
      contentDir: dir,
      fileExtension: "md",
      plugins: [plugin],
    });
    const gen = new Generator({ plugins: [plugin], dryRun: true });
    await gen.run(tree, dir);

    assert.ok(beforeAllCalled, "beforeAll runs in dry-run");
    assert.ok(transformCalled, "transform runs in dry-run");
    assert.deepEqual(afterAllCtx, { dryRun: true }, "afterAll runs with dryRun=true");
    assert.equal(onFileWrittenCalled, false, "onFileWritten skipped in dry-run");
    assert.equal(fs.existsSync(path.join(dir, "index.md")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("onError suppression during tree build drops the node from its parent", async () => {
  const { gen, tree, cleanup } = await runFull({
    pages: [
      { id: "root", title: "Root", markdown: "# r", children: ["a", "b"] },
      { id: "a", title: "A", markdown: "", throws: true, children: [] },
      { id: "b", title: "B", markdown: "# b", children: [] },
    ],
    plugins: [
      {
        name: "swallow",
        hooks: {
          onError: () => true,
        },
      },
    ],
  });
  try {
    const ids = tree.childNodes.map((n) => n.notionId);
    assert.deepEqual(ids, ["b"], "failing child was dropped");
    assert.equal(gen.stats.written, 2); // root + b
    assert.equal(gen.stats.errored, 0);
  } finally {
    cleanup();
  }
});

test("onError suppression during generation increments errored and continues to siblings", async () => {
  // Force a write error on `a` by making its filePath a directory.
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# r", children: ["a", "b"] },
      { id: "a", title: "A", markdown: "# a", children: [] },
      { id: "b", title: "B", markdown: "# b", children: [] },
    ]);

    const plugin: Plugin = {
      name: "swallow",
      hooks: { onError: () => true },
    };

    const tree = await buildPageTree("root", asNotionParser(fake), {
      contentDir: dir,
      fileExtension: "md",
      plugins: [plugin],
    });

    // Force a's destination to be a directory so writeFileSync explodes.
    fs.mkdirSync(path.join(dir, "a.md"), { recursive: true });

    const gen = new Generator({ plugins: [plugin] });
    await gen.run(tree, dir);

    assert.equal(gen.stats.errored, 1);
    // b was a sibling at the same depth — should still be written.
    assert.ok(fs.existsSync(path.join(dir, "b.md")));
    assert.equal(fs.readFileSync(path.join(dir, "b.md"), "utf-8"), "# b");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("onError suppression on a non-leaf drops its children too", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Root", markdown: "# r", children: ["parent", "sibling"] },
      { id: "parent", title: "Parent", markdown: "# p", children: ["child"] },
      { id: "child", title: "Child", markdown: "# c", children: [] },
      { id: "sibling", title: "Sibling", markdown: "# s", children: [] },
    ]);

    const plugin: Plugin = {
      name: "swallow",
      hooks: { onError: () => true },
    };

    const tree = await buildPageTree("root", asNotionParser(fake), {
      contentDir: dir,
      fileExtension: "md",
      plugins: [plugin],
    });

    // Force the parent's index.md to fail by pre-creating its path as a directory.
    fs.mkdirSync(path.join(dir, "parent", "index.md"), {
      recursive: true,
    });

    const gen = new Generator({ plugins: [plugin] });
    await gen.run(tree, dir);

    // 1 for parent write failure + 1 for the dropped child descendant.
    assert.equal(gen.stats.errored, 2);
    assert.ok(
      fs.existsSync(path.join(dir, "sibling.md")),
      "sibling subtree still ran",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("filtered subtree's descendants are not fetched", async () => {
  const { fake, cleanup } = await runFull({
    pages: [
      { id: "root", title: "Root", children: ["a"], markdown: "" },
      { id: "a", title: "Drafts", children: ["leaf"], markdown: "" },
      { id: "leaf", title: "Leaf", children: [], markdown: "" },
    ],
    plugins: [
      {
        name: "drafts-skip",
        hooks: {
          filter: (node) => node.notionTitle !== "Drafts",
        },
      },
    ],
  });
  try {
    // `a` is fetched (filter needs its properties) but `leaf` is never enqueued.
    assert.equal(fake.retrieveCalls.includes("leaf"), false, "descendant was not fetched");
    assert.deepEqual(fake.retrieveCalls.sort(), ["a", "root"]);
  } finally {
    cleanup();
  }
});
