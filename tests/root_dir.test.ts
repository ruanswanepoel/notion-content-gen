import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { generate } from "../src/index.js";
import { Logger } from "../src/logger.js";
import { ConfigSchema, type Config } from "../src/types.js";
import { FakeNotionParser, asNotionParser, mkTmpDir } from "./fakes.js";

function silentLogger() {
  return new Logger({ level: "silent" });
}

test("rootDir: true names the root folder after the real page title (slugified)", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "My Docs", markdown: "# home", children: ["a"] },
      { id: "a", title: "Guide", markdown: "# guide", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      notionPageId: "root",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: true,
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Root gets its own directory named after the title; body → index.md,
    // children nest inside.
    assert.equal(
      fs.readFileSync(path.join(dir, "my-docs", "index.md"), "utf-8"),
      "# home",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "my-docs", "guide.md"), "utf-8"),
      "# guide",
    );
    // Nothing dropped flat into contentDir.
    assert.equal(fs.existsSync(path.join(dir, "index.md")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rootDir: string uses a slugified literal folder name", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "root", title: "Ignored Title", markdown: "# home", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      notionPageId: "root",
      contentDir: dir,
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: "Custom Name",
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    assert.equal(
      fs.readFileSync(path.join(dir, "custom-name", "index.md"), "utf-8"),
      "# home",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rootDir: true on a wiki root names the folder after the database title", async () => {
  const dir = mkTmpDir();
  try {
    const fake = new FakeNotionParser(
      [],
      [
        {
          id: "wiki1",
          title: "Team Handbook",
          items: [
            {
              id: "item",
              title: "Onboarding",
              markdown: "# onboarding",
              children: [],
              parent: {
                type: "data_source_id",
                data_source_id: "wiki1-ds",
                database_id: "wiki1-ds-db",
              },
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
      rootDir: true,
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    // Wiki root is directory-only, but the items land under the named folder.
    assert.equal(
      fs.readFileSync(path.join(dir, "team-handbook", "onboarding.md"), "utf-8"),
      "# onboarding",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rootDir: per-root override beats the top-level default", async () => {
  const flatDir = mkTmpDir();
  const namedDir = mkTmpDir();
  try {
    const fake = new FakeNotionParser([
      { id: "flat", title: "Flat", markdown: "# flat", children: [] },
      { id: "named", title: "Named", markdown: "# named", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: false, // top-level default: flat
      roots: [
        { notionPageId: "flat", contentDir: flatDir },
        { notionPageId: "named", contentDir: namedDir, rootDir: true },
      ],
    };

    await generate(config, {
      logger: silentLogger(),
      notion: asNotionParser(fake),
    });

    assert.ok(fs.existsSync(path.join(flatDir, "index.md")), "flat root");
    assert.ok(
      fs.existsSync(path.join(namedDir, "named", "index.md")),
      "per-root rootDir override applied",
    );
  } finally {
    fs.rmSync(flatDir, { recursive: true, force: true });
    fs.rmSync(namedDir, { recursive: true, force: true });
  }
});

test("config validation: two flat roots on the same contentDir are rejected", () => {
  const result = ConfigSchema.safeParse({
    notionToken: "fake",
    contentDir: "content",
    roots: [{ notionPageId: "a" }, { notionPageId: "b" }],
  });
  assert.equal(result.success, false);
  assert.match(
    result.error!.issues.map((i) => i.message).join("\n"),
    /both write to/,
  );
});

test("config validation: distinct contentDirs (flat) are allowed", () => {
  const result = ConfigSchema.safeParse({
    notionToken: "fake",
    contentDir: "content",
    roots: [
      { notionPageId: "a", contentDir: "content/docs" },
      { notionPageId: "b", contentDir: "content/blog" },
    ],
  });
  assert.equal(result.success, true);
});

test("config validation: shared contentDir with distinct named rootDirs is allowed", () => {
  const result = ConfigSchema.safeParse({
    notionToken: "fake",
    contentDir: "content",
    roots: [
      { notionPageId: "a", rootDir: "docs" },
      { notionPageId: "b", rootDir: "blog" },
    ],
  });
  assert.equal(result.success, true);
});

test("runtime guard: two rootDir:true roots colliding on the same dir throw", async () => {
  const dir = mkTmpDir();
  try {
    // Both titles slug to the same folder, and both share contentDir — the
    // schema can't see this (title-derived), so the run-time guard must catch it.
    const fake = new FakeNotionParser([
      { id: "r1", title: "Same Name", markdown: "# one", children: [] },
      { id: "r2", title: "Same Name", markdown: "# two", children: [] },
    ]);

    const config: Config = {
      notionToken: "fake",
      contentDir: "ignored",
      fileExtension: "md",
      cache: false,
      cleanup: false,
      concurrency: 4,
      rootDir: true,
      roots: [
        { notionPageId: "r1", contentDir: dir },
        { notionPageId: "r2", contentDir: dir },
      ],
    };

    await assert.rejects(
      () =>
        generate(config, {
          logger: silentLogger(),
          notion: asNotionParser(fake),
        }),
      /both write to/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
