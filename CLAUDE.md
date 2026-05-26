# notion-content-gen

CLI tool that fetches a Notion page tree and writes each page as a static file on disk, preserving the Notion page hierarchy as nested directories.

## Vision & Goals

- **Core purpose**: pull static content from Notion according to its page structure — nothing more. The tool is a content sync layer, not a site builder.
- **Primary use case**: CI/CD pipelines. The `generate` command is designed to run non-interactively in automated environments.
- **Plugin system**: users register hooks that can intercept and modify content during generation — e.g. transforming markdown, injecting frontmatter, or filtering pages.
- **File extensions**: `.md` by default, configurable globally. If a Notion page title contains an extension (e.g. `meta.json`, `config.yaml`), that extension is used for the output file instead.

## Stack

- **Runtime**: Node.js ESM (`"type": "module"`)
- **Language**: TypeScript (compiled to `dist/`, entry at `dist/bin/cli.js`)
- **CLI**: Commander.js
- **Notion**: `@notionhq/client` + `notion-to-md`
- **Config validation**: Zod
- **Package manager**: pnpm

## Current layout

> The architecture is in early development and is expected to change significantly as features are added.

```
bin/
  cli.ts                  Commander entrypoint — `init`, `generate`, and `watch` commands
  config.ts               Loads notion-content-gen.config.{ts,js} or .json, validates with Zod
  commands/
    init.ts               Scaffolds a config file
    generate.ts           Thin wrapper: loadConfig() → generate(); parses --dry-run / --verbose / --log-format flags
    watch.ts              Local-dev only: re-runs generate on a timer, shares flags with `generate`
src/
  index.ts                Orchestrates: setup hooks → loads cache, builds page tree, runs generator, saves cache
  notion_parser.ts        Wraps @notionhq/client + notion-to-md (NotionParser class)
  page_node.ts            Builds the PageNode tree via iterative BFS; resolves output paths and incremental-sync state
  generator.ts            Writes output files recursively from the tree; runs plugin hooks; reports new cache
  cache.ts                Load/save the `.notion-content-gen-cache.json` sidecar used for incremental sync
  logger.ts               Logger with text/json formats and debug/info/warn/error/silent levels
  types.ts                Shared types, ConfigSchema (Zod), Plugin type
  util.ts                 slugify, parseTitleForExtension, computeNodeFilePath, getTreeString, safeStringify, getPackageType
  plugins/
    frontmatter.ts        Generic YAML frontmatter plugin (caller supplies the extractor)
    mdx_blocks.ts         Notion callout → <Callout>; toggle → <Accordion>
  presets/
    fumadocs.ts           Fumadocs preset: bundles draft filter + mdx-blocks + frontmatter + _meta.json
```

## How it works

1. `generate` command calls `loadConfig()` → validates config via `ConfigSchema`, merges `plugins` from raw config
2. `src/index.ts` creates a `NotionParser`, runs each plugin's `setup` hook against it (used to register `notion-to-md` custom transformers etc.), loads the cache (if enabled), then calls `buildPageTree(rootId, notionParser, { cache, contentDir, fileExtension, plugins, concurrency, logger })`
3. `buildPageTree` runs a BFS worker pool (default 4 concurrent fetches, configurable via `concurrency`). Each node fetches its page + paginated block children via `notionParser.retrievePage()`. When a cache is provided, retrieval skips markdown conversion, resolves the expected output path, and marks the node `unchanged` if `last_edited_time` + path match the cache and the file still exists. Otherwise the markdown is converted in-place. Sibling slug collisions are resolved deterministically at parent-visit time (`-2`, `-3`, … suffixes) so worker scheduling doesn't change the output. Per-node retrieval errors are routed to plugin `onError` hooks; suppressed non-root failures are dropped from their parent's `childNodes`. All Notion calls run through `withRetry` (exponential backoff with jitter; respects `Retry-After` on 429s).
4. `Generator.run(tree, contentDir)` runs the full lifecycle: `beforeAll` hooks → `generateContent` recursion → `afterAll` hooks. At each node:
   - `filter` hooks run first — returning `false` skips the node and its children
   - Leaf pages → `slug.md` (or title-derived extension if the page title includes one)
   - Pages with children → `slug/index.md`
   - `unchanged` nodes with an existing output file are not rewritten (their plugin `transform`/`onFileWritten` hooks are also skipped)
   - `transform` hooks modify the markdown string before writing
   - `onFileWritten` hooks fire after each file is written
   - Any error from the filter/write/transform/onFileWritten path is sent to `onError`; if suppressed, the node's children still get a chance to run
5. After generation, the orchestrator compares the previous cache against the new one and deletes any files whose paths are no longer claimed (page deleted, renamed, or moved in Notion). Only paths recorded in the previous cache are eligible — anything else in `contentDir` is never touched. Empty parent directories are pruned. Cleanup is gated by the `cleanup` config option (default `true`) and is a no-op when caching is disabled. The fresh cache is then written back to the sidecar JSON file. Entries for pages that no longer exist (or that errored without a successful write this run) are implicitly pruned.

## Incremental sync

When enabled (default), a JSON sidecar file (`.notion-content-gen-cache.json` in `cwd` by default) records each page's `last_edited_time` and resolved output `filePath` between runs. On the next run, pages whose `last_edited_time` and target path are unchanged and whose output file still exists are skipped — no markdown conversion, no file write.

- Toggle via the `cache` config option: `true` (default), `false` (disable), or a string path (custom cache file location).
- The cache file should typically be gitignored locally but persisted between CI runs (e.g. via the CI's cache action) to keep generation fast.
- Cache misses (missing entry, mismatching `last_edited_time`, mismatching path, missing output file, or version bump) fall back to a full sync for that page.

## CLI commands

### `generate`

```
notion-content-gen generate [--dry-run] [--verbose] [--log-format text|json] [--log-level <level>]
```

- **`--dry-run`** — resolve the full tree and run plugins, but skip every file write and skip saving the cache. Each would-be-write is logged as `[dry-run] would create|update: <path>`. Use this in CI to preview a sync before committing output. In dry-run, `afterAll` and `onFileWritten` hooks are skipped (they typically write sidecar files); `beforeAll`, `filter`, and `transform` still run.
- **`--verbose`** / **`-v`** — equivalent to `--log-level debug`. Emits per-node decisions (`unchanged`, `created`, `updated`).
- **`--log-format <text|json>`** — `text` is the human-readable default. `json` emits one JSON object per line (`{ time, level, msg, ...meta }`) for log aggregators.
- **`--log-level <level>`** — `debug | info | warn | error | silent`. Overrides `--verbose`. Info goes to stdout; warn/error go to stderr.

### `watch` (local dev only)

```
notion-content-gen watch [--interval <seconds>] [--dry-run] [--verbose] [--log-format text|json] [--log-level <level>]
```

Re-runs `generate` on a timer for local development. Pairs with incremental sync so subsequent runs only refetch changed pages. **Not intended for CI** — CI should call `generate` once at build time. `--interval` defaults to `30` seconds; minimum is `1`. Generation errors are logged but do not exit the loop. Ctrl+C (SIGINT/SIGTERM) stops cleanly.

In addition to the timer, watch mode tracks the active config file (`notion-content-gen.config.{ts,js,json}`) plus any local plugin files referenced through relative imports in the config. Saving any of those files triggers an immediate re-run — useful when iterating on a `transform` or `filter` hook without restarting the process. The ESM module cache is busted on each reload so edits actually take effect.

### Programmatic API

```ts
import { generate, Logger } from "notion-content-gen";

await generate(config, {
  dryRun: true,
  logger: new Logger({ level: "debug", format: "json" }),
});
```

`generate(config, options)` returns the `GenerationStats` (`written`, `created`, `updated`, `skipped`, `filtered`, `errored`, `removed`).

## Plugin system

Plugins are objects with optional hook functions, defined in the config file:

```ts
type Plugin = {
  name: string;
  hooks?: {
    setup?: (ctx: { notion: NotionParser; dryRun: boolean; logger: Logger }) => void | Promise<void>;
    beforeAll?: (tree: PageNode, ctx: { dryRun: boolean; logger: Logger }) => void | Promise<void>;
    afterAll?: (tree: PageNode, ctx: { dryRun: boolean; logger: Logger }) => void | Promise<void>;
    filter?: (node: PageNode) => boolean | Promise<boolean>;
    transform?: (content: string, node: PageNode) => string | Promise<string>;
    onFileWritten?: (filePath: string, node: PageNode) => void | Promise<void>;
    onError?: (
      err: unknown,
      node: PageNode,
    ) => boolean | void | Promise<boolean | void>;
  };
};
```

Plugins are passed through as-is from the config file (not Zod-validated, since functions aren't serialisable). `bin/config.ts` reads `rawConfig.plugins` after Zod validation and merges it into the returned config.

### `PageNode` shape

Notion page data is promoted to first-class fields on the node — plugins do
not need to reach through nested optional chaining:

```ts
type PageNode = {
  notionId: string;
  notionTitle: string;                            // updated from the fetched page on the root
  page: PageObjectResponse | null;
  properties: PageObjectResponse["properties"] | null;
  icon: PageObjectResponse["icon"] | null;
  lastEditedTime: string | null;
  blocks: BlockObjectResponse[];
  mdString: string;
  childPageBlock: ChildPageBlockObjectResponse | null;
  parentNode: PageNode | null;
  childNodes: PageNode[];
  filePath?: string;
  childDir?: string;
  unchanged?: boolean;
  resolvedTitle?: string;
  filtered?: boolean;
};
```

Use `getProperty(node, name)` (exported from `notion-content-gen`) to look up
a Notion property by name. It returns the raw typed property object (with its
`type` discriminator) so callers can narrow:

```ts
import { getProperty } from "notion-content-gen";

const prop = getProperty(node, "Description");
if (prop?.type === "rich_text") {
  const text = prop.rich_text.map((r) => r.plain_text).join("");
}
```

The synthetic root node starts with `notionTitle = "Root"` and is overwritten
with the fetched page's title once Notion responds. Its `parentNode` is
always `null`, which is the canonical way for presets to detect the root and
opt out of frontmatter / sidebar entries.

### Hooks reference

- **`setup({ notion, dryRun, logger })`** — runs once before any Notion API call. Use this to register `notion-to-md` custom transformers, prime caches, or otherwise configure the parser. Plugins run sequentially in declaration order.
- **`beforeAll(tree, ctx)`** — runs once after the page tree is built, before any file is written. Useful for tree-wide setup (caches, indexes, validating expected pages). `ctx` is `{ dryRun, logger }`.
- **`afterAll(tree, ctx)`** — runs once after the last file is written, *in dry-run mode too* so plugins can run validation. Plugins that write sidecar artifacts (e.g. `_meta.json`) should guard on `ctx.dryRun`.
- **`filter(node)`** — runs *during tree build*, immediately after the page is fetched. Returning `false` skips the node and its descendants — neither the subtree's markdown conversion nor its child fetches happen. The Generator honors the build-time decision; it does not re-invoke `filter`. First plugin to return `false` wins.
- **`transform(content, node)`** — pipeline: each plugin receives the previous plugin's output. Use for frontmatter injection, block transformations, etc.
- **`onFileWritten(filePath, node)`** — fires once per successful write. Skipped in dry-run.
- **`onError(err, node)`** — fires when a per-node error occurs during tree build (parse/retrieval) or generation (write/transform/onFileWritten). Return `true` to suppress the error and continue. All `onError` handlers see every error — they don't short-circuit. **Note:** when generation suppresses a write error on a non-leaf node, the node's children are also skipped — the parent `index` is missing so the directory would be broken downstream.

All hooks may return promises; the runner awaits them in plugin order.

### Hook ordering in presets

Plugins fire in config-declaration order. Presets that return `Plugin[]`
(like `fumadocsPreset`) put the user's plugins before or after the preset's
depending on spread position:

```ts
plugins: [...fumadocsPreset(), myPlugin]   // myPlugin runs after preset (sees its frontmatter)
plugins: [myPlugin, ...fumadocsPreset()]   // myPlugin runs first (preset wraps its output)
```

Worth keeping in mind when writing a `transform` that should run before or
after frontmatter injection.

### `filter` hook recipes

The built-in `filter` hook is expressive enough to cover common gating patterns
without dedicated config. A few canonical examples:

```ts
import { getProperty } from "notion-content-gen";

// Hide pages flagged via a Notion `Published` checkbox property
{
  name: "drafts",
  hooks: {
    filter: (node) => {
      const prop = getProperty(node, "Published");
      return prop?.type !== "checkbox" || prop.checkbox !== false;
    },
  },
}

// Title-prefix convention: skip anything starting with 🚧
{
  name: "construction",
  hooks: {
    filter: (node) => !node.notionTitle.startsWith("🚧"),
  },
}

// Role-based visibility via a Notion `Audience` multi_select
{
  name: "audience",
  hooks: {
    filter: (node) => {
      const prop = getProperty(node, "Audience");
      if (prop?.type !== "multi_select") return true;
      return prop.multi_select.some((t) => t.name === "public");
    },
  },
}
```

Because `filter` returning `false` skips a node *and* its descendants, prefer
gating high in the tree (e.g. a whole "Drafts" section) over per-leaf checks
when the structure allows it.

## First-party plugins & presets

First-party plugins and presets live in-tree (under `src/plugins/` and
`src/presets/`) and are published as subpath exports of the package. They use
the same hook API as user plugins — no special access — and serve as canonical
examples.

### `notion-content-gen/plugins/frontmatter`

Generic YAML frontmatter — caller supplies the extractor, no built-in shape.

```ts
import { frontmatterPlugin } from "notion-content-gen/plugins/frontmatter";

const fm = frontmatterPlugin((node) => ({
  title: node.notionTitle,
  slug: node.filePath,
}));
```

The extractor may be async and may return `undefined`/`null` to skip a node.
`undefined`/`null` values in the returned object are dropped so callers can
return partial data freely. Strings are quoted only when they need it (special
chars, leading/trailing whitespace, YAML reserved words, or anything that
parses as a number).

### `notion-content-gen/plugins/mdx-blocks`

Maps Notion block types to MDX components:

- **Callout** — fully rewritten via a `notion-to-md` custom transformer (registered in `setup`) → `<Callout type="info|warn|error">`. The emoji on the callout drives the type via a default map (override with `calloutTypeByEmoji`).
- **Toggle** — post-processed in `transform`: the default `<details><summary>…</summary>…</details>` output is rewritten to `<Accordions><Accordion title="…">…</Accordion></Accordions>`. Adjacent toggles collapse into a single `<Accordions>` container.
- **Columns** — *not transformed.* `notion-to-md` discards `column_list`/`column` container blocks before reaching markdown, so structure isn't recoverable post-conversion. Documented as a known limitation.

### `notion-content-gen/presets/fumadocs`

Bundles the plugins required for Fumadocs-compatible output:

- YAML frontmatter (`title`, `description`, `icon`, `full`) drawn from Notion page properties (property names are configurable)
- `_meta.json` per non-leaf directory, listing child slugs in Notion's order (driven by an `afterAll` hook)
- MDX block transformations (via the `mdx-blocks` plugin)
- Draft filtering via a Notion checkbox property (default: `Published`); missing property = keep

```ts
import { fumadocsPreset } from "notion-content-gen/presets/fumadocs";

export default {
  // …
  plugins: [
    ...fumadocsPreset({
      publishedProperty: "Published",
      descriptionProperty: "Description",
      fullProperty: "Full",
    }),
  ],
};
```

The preset returns a `Plugin[]`, so callers can spread it alongside their own
plugins, reorder, or drop individual entries.

## Build & type-check

```bash
pnpm check   # tsc --noEmit
pnpm build   # tsc (outputs to dist/)
pnpm test    # node --test against tests/*.test.ts (TS via tsx)
```

The test harness wraps the Generator/buildPageTree against a fake
`NotionParser` (no Notion network required). See `tests/` for the suite.

## Config format

```ts
// notion-content-gen.config.ts
import type { Config } from "notion-content-gen";

const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  notionPageId: "<root-page-id>",
  contentDir: "content",        // output directory, defaults to "content"
  fileExtension: "md",          // default file extension, defaults to "md"
  cache: true,                  // incremental sync; true (default), false, or custom path
  cleanup: true,                // delete files for pages removed/renamed in Notion (default true)
  concurrency: 4,               // max concurrent Notion fetches during tree build (default 4)
  plugins: [
    {
      name: "my-plugin",
      hooks: {
        beforeAll: (tree) => console.log(`Starting sync from ${tree.notionId}`),
        afterAll: async (tree) => {
          // Async hooks are awaited in plugin order.
          await writeSitemap(tree);
        },
        filter: (node) => node.notionTitle !== "Draft",
        transform: (content) => `<!-- generated -->\n${content}`,
        onFileWritten: (filePath) => console.log(`Written: ${filePath}`),
        onError: (err, node) => {
          console.warn(`Skipping ${node.notionTitle}:`, err);
          return true; // suppress and continue
        },
      },
    },
  ],
};
export default config;
```
