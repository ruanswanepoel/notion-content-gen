# notion-content-gen

A CLI tool (and library) that fetches a Notion page tree — or a Notion wiki — and
writes each page to disk as a static file, preserving the Notion hierarchy as
nested directories. It's a **content sync layer, not a site builder**: its job
ends at writing files. Point a static site generator (Fumadocs, Astro, Next.js,
Hugo, …) at the output and let it do the rendering.

- **CI/CD first** — `generate` runs non-interactively; ideal for build pipelines.
- **Incremental** — a cache sidecar skips unchanged pages on subsequent runs.
- **Extensible** — a plugin/hook system lets you transform content, inject
  frontmatter, download assets, filter drafts, and more.
- **Wikis are first-class** — Notion wikis (databases under the hood) are walked
  and their hierarchy is faithfully reconstructed on disk.
- **Multi-root** — sync several Notion roots into several output directories in a
  single run, sharing one cache.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Notion setup](#notion-setup)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CLI commands](#cli-commands)
- [How it works](#how-it-works)
- [Incremental sync](#incremental-sync)
- [Cleanup](#cleanup)
- [File naming rules](#file-naming-rules)
- [Wikis](#wikis)
- [Plugin system](#plugin-system)
- [First-party plugins & presets](#first-party-plugins--presets)
- [Programmatic API](#programmatic-api)
- [Development](#development)
- [Project layout](#project-layout)
- [License](#license)

---

## Requirements

- **Node.js** 18+ (the tool is ESM-only — `"type": "module"`).
- A **Notion internal integration** token and at least one page/wiki shared with it.
- Any package manager (`pnpm`, `npm`, `yarn`). The repo itself uses **pnpm**.

## Installation

Install globally to get the `notion-content-gen` binary on your `PATH`:

```bash
npm install -g notion-content-gen
```

Or add it as a dev dependency and run it via your package runner:

```bash
pnpm add -D notion-content-gen
pnpm exec notion-content-gen generate
```

## Notion setup

1. Create an **internal integration** at
   <https://www.notion.so/my-integrations> and copy its secret
   (`ntn_…` / `secret_…`).
2. Open the Notion page (or wiki) you want to sync, and via the **`···` → Connections**
   menu, connect your integration so it has read access.
3. Grab the **page ID** from the page URL — it's the 32-character hex string at
   the end (dashes optional):
   `https://www.notion.so/My-Page-`**`2b3717f5edb9802b9fd6cae83ae97abc`**.
   A wiki/database id works here too — the tool auto-detects which it is.

Keep the secret out of source control. The scaffolded config reads it from an
environment variable via `dotenv`, so a `.env` file works well:

```bash
# .env
NOTION_SECRET=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Quick start

```bash
# 1. Scaffold a config file in your project (defaults to .config.js)
notion-content-gen init                 # or: init -c ts | -c json

# 2. Edit the config: set your Notion secret + root page id (see above)

# 3. Preview what would be written, without touching disk
notion-content-gen generate --dry-run

# 4. Generate for real
notion-content-gen generate
```

Output lands in `contentDir` (default `content/`), mirroring the Notion tree.

## Configuration

On startup the tool looks for the first of these in the current working directory:

```
notion-content-gen.config.ts
notion-content-gen.config.js
notion-content-gen.json
```

`.ts`/`.js` configs are dynamically imported (so `plugins` can contain live
functions); `.json` is parsed as data (no plugins). Every config is validated
with Zod, and a helpful error is printed if it's invalid.

### Single-root (shorthand)

```ts
// notion-content-gen.config.ts
import "dotenv/config";
import type { Config } from "notion-content-gen";

const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  notionPageId: "<root-page-id>", // a page id OR a wiki/database id — auto-detected
  contentDir: "content",
  fileExtension: "md",
  cache: true,
  cleanup: true,
  concurrency: 4,
  plugins: [],
};

export default config;
```

### Multi-root

`notionPageId` and `roots` are **mutually exclusive** — supply exactly one.
Each root can be a page or a wiki, gets its own `contentDir`, and optionally its
own `fileExtension` (falling back to the top-level values when omitted).

```ts
const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  contentDir: "content",
  fileExtension: "md",
  cache: true,
  cleanup: true,
  concurrency: 4,
  roots: [
    { notionPageId: "<docs-page-id>", contentDir: "content/docs" },
    { notionPageId: "<wiki-id>",      contentDir: "content/handbook" },
    { notionPageId: "<blog-page-id>", contentDir: "content/blog", fileExtension: "mdx" },
  ],
  plugins: [/* shared across all roots */],
};
```

### Options

| Option          | Type                       | Default     | Description |
| --------------- | -------------------------- | ----------- | ----------- |
| `notionToken`   | `string` (required)        | —           | Notion integration secret. |
| `notionPageId`  | `string`                   | —           | Single root page/wiki id. Mutually exclusive with `roots`. |
| `roots`         | `RootConfig[]`             | —           | Multiple roots to sync in one run. Mutually exclusive with `notionPageId`. |
| `contentDir`    | `string`                   | `"content"` | Output directory (per-root overridable). |
| `fileExtension` | `string`                   | `"md"`      | Default output extension (per-root overridable). Overridden per-file if a page title contains an extension. |
| `cache`         | `boolean \| string`        | `true`      | Incremental sync: `true`, `false`, or a custom cache-file path. |
| `cleanup`       | `boolean`                  | `true`      | Delete output files for pages removed/renamed in Notion. |
| `concurrency`   | `number` (1–20)            | `4`         | Max concurrent Notion fetches during tree build. |
| `plugins`       | `Plugin[]`                 | `[]`        | Hook plugins (see below). Passed through as-is; not Zod-validated. |

A `RootConfig` is `{ notionPageId, contentDir?, fileExtension? }`.

## CLI commands

### `generate`

```
notion-content-gen generate [--dry-run] [-v|--verbose] [--log-format text|json] [--log-level <level>]
```

Fetches the tree, runs plugins, and writes files. This is the command you run in CI.

- **`--dry-run`** — resolve the full tree and run plugins, but skip every file
  write and skip saving the cache. Each would-be write is logged as
  `[dry-run] would create|update: <path>`. In dry-run, `afterAll` and
  `onFileWritten` hooks are skipped (they typically write sidecar files);
  `beforeAll`, `filter`, and `transform` still run.
- **`-v`, `--verbose`** — equivalent to `--log-level debug`; emits per-node
  decisions (`unchanged` / `created` / `updated`).
- **`--log-format <text|json>`** — `text` (human-readable, default) or `json`
  (one JSON object per line, for log aggregators).
- **`--log-level <level>`** — `debug | info | warn | error | silent`. Overrides
  `--verbose`. Info goes to stdout; warn/error go to stderr.

### `watch` (local dev only)

```
notion-content-gen watch [-i|--interval <seconds>] [--dry-run] [-v] [--log-format …] [--log-level …]
```

Re-runs `generate` on a timer for local iteration. Pairs with incremental sync
so subsequent runs only refetch changed pages. **Not for CI** — CI should call
`generate` once at build time.

- `--interval` defaults to `30` seconds (minimum `1`).
- In addition to the timer, saving the active config file **or any local plugin
  file referenced through relative imports in the config** triggers an immediate
  re-run — handy while iterating on a `transform`/`filter` hook. The ESM module
  cache is busted on reload so edits take effect.
- Generation errors are logged but don't stop the loop. `Ctrl+C`
  (SIGINT/SIGTERM) exits cleanly.

### `init`

```
notion-content-gen init [-c|--config js|ts|json]
```

Scaffolds a starter config file (default `js`). Fails if a config already exists.

## How it works

1. `generate` loads and validates the config, then constructs a single
   `NotionParser` and runs each plugin's `setup` hook against it once (shared
   across all roots).
2. The cache is loaded, then each root is processed **sequentially** (they share
   a workspace and would otherwise compete for rate limits).
3. For each root, the orchestrator probes the id (`classifyNode`) to decide
   whether it's a **page** or a **wiki**, then builds the tree:
   - **Page nodes** paginate block children. `child_page` blocks become page
     children; `child_database` blocks become wiki children.
   - **Wiki nodes** paginate the database's data source(s) and reconstruct the
     hierarchy from each item's `parent` field.
4. Tree building runs a **BFS worker pool** (default 4 concurrent fetches). Sibling
   slug collisions are resolved deterministically (`-2`, `-3`, … suffixes) so
   scheduling never changes the output. All Notion calls run through `withRetry`
   (exponential backoff with jitter; respects `Retry-After` on 429s).
5. The `Generator` runs the lifecycle `beforeAll → generateContent → afterAll`,
   writing files, running `filter`/`transform`/`onFileWritten` hooks, and
   skipping unchanged pages.
6. After each root, stale files (pages deleted/renamed/moved in Notion) are
   cleaned up — scoped per root. Finally the merged cache is written back.

## Incremental sync

A JSON sidecar (`.notion-content-gen-cache.json` in the cwd by default) records
each page's `last_edited_time` and resolved output path between runs. On the next
run, a page is skipped — no markdown conversion, no write — when its
`last_edited_time`, target path, and existing output file all still match.

- Toggle with `cache`: `true` (default), `false` (disable), or a string path.
- Cache misses (missing entry, changed `last_edited_time`, changed path, missing
  output file, or a cache-version bump) fall back to a full sync for that page.
- The cache is keyed by Notion root id:
  `{ version: 2, roots: { "<rootId>": { entries: { "<nodeId>": { lastEditedTime, filePath } } } } }`.
  Multi-root setups share one cache file.
- **Gitignore it locally, but persist it between CI runs** (e.g. via your CI's
  cache action) to keep generation fast.

## Cleanup

When `cleanup` is `true` (default), files for pages that were removed, renamed,
or moved in Notion since the last run are deleted, and empty parent directories
are pruned. Cleanup only touches paths the **previous cache** recorded as
ours — anything else in `contentDir` is left alone — and it's scoped per root, so
one root can never delete another's files. Cleanup is a no-op when caching is
disabled. Disable it if something else also writes into `contentDir`.

## File naming rules

- Leaf pages → `slug.md`.
- Pages with children → `slug/index.md` (a directory plus its index file).
- **Wiki nodes are directory-only** — no file is written for the wiki itself.
  To create an index page inside a wiki, add a wiki item whose title slugs to
  `index`.
- If a page title contains an extension (e.g. `meta.json`, `config.yaml`), that
  extension is used for the file instead of the configured `fileExtension`.

## Wikis

Wikis are auto-detected — no config flag needed; just pass a wiki id as a root.
Notion wikis are databases under the hood: the tool retrieves the database and
paginates its data source(s), then rebuilds the hierarchy from each page's
`parent` field. Wikis can appear anywhere in the tree — top-level or nested
inside a regular page.

Known limitations:

- Regular (non-wiki) pages pasted **inside** a wiki item aren't returned by the
  database query and won't be synced. Move them into the wiki database, or use
  page traversal instead.
- Notion's manual UI sort order for wiki items isn't exposed by the API; items
  come back in data-source order.

## Plugin system

Plugins are objects with optional async hook functions, declared in the config's
`plugins` array. They run in declaration order.

```ts
type Plugin = {
  name: string;
  hooks?: {
    setup?:         (ctx: { notion: NotionParser; dryRun: boolean; logger: Logger }) => void | Promise<void>;
    beforeAll?:     (tree: PageNode, ctx: { dryRun: boolean; logger: Logger }) => void | Promise<void>;
    afterAll?:      (tree: PageNode, ctx: { dryRun: boolean; logger: Logger }) => void | Promise<void>;
    filter?:        (node: PageNode) => boolean | Promise<boolean>;
    transform?:     (content: string, node: PageNode) => string | Promise<string>;
    onFileWritten?: (filePath: string, node: PageNode) => void | Promise<void>;
    onError?:       (err: unknown, node: PageNode) => boolean | void | Promise<boolean | void>;
  };
};
```

| Hook            | When it fires | Notes |
| --------------- | ------------- | ----- |
| `setup`         | Once per run, before any API call | Register `notion-to-md` transformers, prime caches. |
| `beforeAll`     | Once per root, after its tree is built | Receives that root's tree. |
| `afterAll`      | Once per root, after its files are written (**also in dry-run**) | Guard sidecar writes on `ctx.dryRun`. |
| `filter`        | During tree build, right after a page is fetched | Returning `false` skips the node **and its descendants**. First `false` wins. |
| `transform`     | Before each file is written | Pipeline — each plugin sees the previous plugin's output. |
| `onFileWritten` | After each successful write | Skipped in dry-run. |
| `onError`       | On any per-node error (build or generation) | Return `true` to suppress and continue. All handlers see every error. |

A few things worth knowing:

- **`PageNode`** promotes Notion data to first-class fields (`notionTitle`,
  `page`, `properties`, `blocks`, `mdString`, `filePath`, `childNodes`,
  `parentNode`, a `kind: "page" | "wiki"` discriminator, …) so plugins rarely
  need deep optional chaining. Use the exported `getProperty(node, name)` helper
  to read a typed Notion property.
- The **synthetic root** has `parentNode === null` — the canonical way for
  plugins to detect the root and opt out of frontmatter/sidebar entries.
- Suppressing a write error on a **non-leaf** node also drops its children (a
  directory with no `index` is unusable downstream).

### Example

```ts
import { getProperty } from "notion-content-gen";

const config = {
  // …
  plugins: [
    {
      name: "drafts",
      hooks: {
        // Hide pages whose Notion `Published` checkbox is explicitly false
        filter: (node) => {
          const prop = getProperty(node, "Published");
          return prop?.type !== "checkbox" || prop.checkbox !== false;
        },
        transform: (content) => `<!-- generated from Notion -->\n${content}`,
        onError: (err, node) => {
          console.warn(`Skipping ${node.notionTitle}:`, err);
          return true; // suppress and continue
        },
      },
    },
  ],
};
```

## First-party plugins & presets

Shipped as subpath exports of the package; they use the same public hook API.

### `notion-content-gen/plugins/assets`

Downloads media served from Notion's CDN (behind signed, expiring URLs) and
rewrites markdown references to durable local paths — or a supplied CDN base — so
output is self-contained and safe to host statically.

```ts
import { assetsPlugin } from "notion-content-gen/plugins/assets";

assetsPlugin({
  outputDir: "public/notion-assets",  // where bytes land
  publicPath: "/notion-assets",        // reference prefix; omit for page-relative
  includeExternal: false,              // also pull permanent external URLs
  blockTypes: ["image", "file", "pdf", "video", "audio"],
  concurrency: 4,
  naming: "blockId",                   // "blockId" | "urlHash" | "original"
});
```

Filenames are derived from stable inputs (block id or hashed URL path — never the
expiring query string), so re-runs are idempotent. Icons/covers and unchanged
pages are out of scope; orphaned assets accumulate until you wipe `outputDir`.

### `notion-content-gen/plugins/frontmatter`

Generic YAML frontmatter — you supply the extractor (may be async; return
`undefined`/`null` to skip a node). `undefined`/`null` values are dropped;
strings are quoted only when needed.

```ts
import { frontmatterPlugin } from "notion-content-gen/plugins/frontmatter";

const fm = frontmatterPlugin((node) => ({ title: node.notionTitle, slug: node.filePath }));
```

### `notion-content-gen/plugins/mdx-blocks`

Maps Notion blocks to MDX components: **callouts** → `<Callout type="…">` (type
driven by the emoji, overridable), **toggles** → `<Accordions><Accordion>`
(adjacent toggles collapse into one container). Column layouts aren't
recoverable post-conversion and are left as a documented limitation.

### `notion-content-gen/presets/fumadocs`

Bundles everything needed for [Fumadocs](https://fumadocs.dev)-compatible output:
YAML frontmatter from page properties, `_meta.json` per non-leaf directory (in
Notion order), MDX block transforms, and draft filtering via a checkbox property.

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

The preset returns a `Plugin[]`, so you can spread it, reorder, or drop entries.
Spread position controls ordering relative to your own plugins:

```ts
plugins: [...fumadocsPreset(), myPlugin]  // myPlugin runs after preset (sees its frontmatter)
plugins: [myPlugin, ...fumadocsPreset()]  // myPlugin runs first (preset wraps its output)
```

## Programmatic API

```ts
import { generate, Logger } from "notion-content-gen";

const stats = await generate(config, {
  dryRun: true,
  logger: new Logger({ level: "debug", format: "json" }),
  // notion: customNotionParser,   // optional injected parser (tests/sharing)
});
// → { written, created, updated, skipped, filtered, errored, removed }
```

`notion-content-gen` also exports `NotionParser`, `getProperty`, and the shared
types (`Config`, `Plugin`, `PageNode`, `LogLevel`, `LogFormat`, `NodeKind`,
`RetrievedPage`, `RetrievedDatabase`, `RootConfig`, …). Canonical Notion SDK
shapes are re-exported from `notion-content-gen/types`.

## Development

```bash
pnpm install
pnpm check   # tsc --noEmit (src + tests)
pnpm build   # tsc → dist/  (entry: dist/bin/cli.js)
pnpm test    # node --test against tests/*.test.ts (TS via tsx)
```

The test suite drives the `Generator`/`buildPageTree` against a fake
`NotionParser` (see `tests/fakes.ts`), so no Notion network access is required.

## Project layout

```
bin/
  cli.ts                Commander entrypoint — init, generate, watch
  config.ts             Loads notion-content-gen.config.{ts,js} or .json; validates with Zod
  commands/             init, generate, watch command handlers
src/
  index.ts              Orchestrator: setup hooks → cache → per-root (classify → build → generate → cleanup)
  notion_parser.ts      Wraps @notionhq/client + notion-to-md; page + database endpoints; classifyNode
  page_node.ts          Builds the PageNode tree; resolves paths and incremental-sync state
  generator.ts          Writes files recursively; runs plugin hooks; reports new cache slice
  cache.ts              Load/save the root-keyed cache sidecar
  logger.ts             text/json logger with debug/info/warn/error/silent levels
  retry.ts              withRetry — backoff with jitter, Retry-After aware
  types.ts              Shared types, Zod ConfigSchema, Plugin type
  util.ts               slugify, extension parsing, path resolution, tree printing
  plugins/              assets, frontmatter, mdx-blocks (first-party)
  presets/              fumadocs
tests/                  node:test suites against a fake NotionParser
```

See [CLAUDE.md](CLAUDE.md) for a deeper architectural walkthrough and
[PLANNED.md](PLANNED.md) for the roadmap and intentional non-goals.

## License

[Apache-2.0](LICENSE).
