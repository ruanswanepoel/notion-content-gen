# notion-content-gen

CLI tool that fetches a Notion page tree (or wiki) and writes each page as a
static file on disk, preserving the Notion hierarchy as nested directories.

## Vision & Goals

- **Core purpose**: pull static content from Notion according to its page structure — nothing more. The tool is a content sync layer, not a site builder.
- **Primary use case**: CI/CD pipelines. The `generate` command is designed to run non-interactively in automated environments.
- **Plugin system**: users register hooks that can intercept and modify content during generation — e.g. transforming markdown, injecting frontmatter, or filtering pages.
- **File extensions**: `.md` by default, configurable globally. If a Notion page title contains an extension (e.g. `meta.json`, `config.yaml`), that extension is used for the output file instead.
- **Wikis are first-class.** Notion wikis (which are databases under the hood) are walked via `databases.retrieve` + a paginated `dataSources.query`. Every page in the wiki — including nested sub-pages — comes back in one paginated stream, and the hierarchy is reconstructed from each page's `parent` field. Wikis can appear anywhere in the tree (top-level or nested inside a regular page) and detection happens at traversal time.
- **Multi-root**: a single config can sync multiple Notion roots into multiple `contentDir`s in one run, with a single cache file keyed by root id.

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
  index.ts                Orchestrates: setup hooks → loads cache, iterates roots (classify → buildPageTree → generator → cleanup), saves cache
  notion_parser.ts        Wraps @notionhq/client + notion-to-md; page + database/data-source endpoints, classifyNode probe
  page_node.ts            Builds the heterogeneous PageNode tree (page + wiki nodes); resolves output paths and incremental-sync state
  generator.ts            Writes output files recursively from the tree; runs plugin hooks; reports new cache slice
  cache.ts                Load/save the root-keyed `.notion-content-gen-cache.json` sidecar
  logger.ts               Logger with text/json formats and debug/info/warn/error/silent levels
  types.ts                Shared types, ConfigSchema (Zod, single-root or roots[] form), Plugin type, NodeKind
  util.ts                 slugify, parseTitleForExtension, computeNodeFilePath, getTreeString, getPackageType
  plugins/
    assets.ts             Downloads Notion CDN media (image/file/pdf/video/audio) and rewrites references to local/CDN paths
    frontmatter.ts        Generic YAML frontmatter plugin (caller supplies the extractor)
    mdx_blocks.ts         Notion callout → <Callout>; toggle → <Accordion>
  presets/
    fumadocs.ts           Fumadocs preset: bundles draft filter + mdx-blocks + frontmatter + meta.json
```

## How it works

1. `generate` command calls `loadConfig()` → validates config via `ConfigSchema`, merges `plugins` from raw config.
2. `src/index.ts` creates a single `NotionParser`, runs each plugin's `setup` hook against it once (shared across roots), loads the cache, then iterates the normalized root list sequentially.
3. For each root, the orchestrator calls `NotionParser.classifyNode(id)` (one extra API call per root, one-time) to determine whether the root is a regular page or a wiki, then dispatches to `buildPageTree(rootId, notion, { cache: rootSlice, contentDir, fileExtension, plugins, concurrency, logger, rootKind })`.
4. `buildPageTree` runs a BFS worker pool (default 4 concurrent fetches, configurable via `concurrency`). Each node is visited according to its `kind`:
   - **Page nodes** call `notionParser.retrievePage()`, paginating block children. `child_page` blocks → new page children. `child_database` blocks → new wiki children. When a cache is provided, retrieval skips markdown conversion, resolves the expected output path, and marks the node `unchanged` if `last_edited_time` + path match the cache and the file still exists. Otherwise the markdown is converted in-place.
   - **Wiki nodes** call `notionParser.retrieveDatabase()` which under the hood paginates `dataSources.query` for every data source attached to the database and returns the flat list of page objects. The tree builder reconstructs the wiki hierarchy by walking each page's `parent` field — top-level items live under the wiki, nested items live under whichever wiki item's id matches `parent.page_id`. Each wiki item becomes a `kind: "page"` node (flagged `wikiItem: true`) with its page object pre-populated (no extra `pages.retrieve` round-trip), and the worker pool fetches each item's blocks for content. **Wiki items get their hierarchy solely from the database `parent` graph**: when the worker later visits a wiki item as a page node, it does *not* re-derive children from that item's `child_page`/`child_database` blocks. In Notion a wiki entry's sub-pages surface both as data-source rows and as `child_page` blocks, so deriving from blocks would materialize every sub-page twice (slug collisions + `-2` duplicate files).
5. Sibling slug collisions are resolved deterministically at parent-visit time (`-2`, `-3`, … suffixes) so worker scheduling doesn't change the output. Per-node retrieval errors are routed to plugin `onError` hooks; suppressed non-root failures are dropped from their parent's `childNodes`. All Notion calls run through `withRetry` (exponential backoff with jitter; respects `Retry-After` on 429s).
6. `Generator.run(tree, contentDir)` runs the full lifecycle: `beforeAll` hooks → `generateContent` recursion → `afterAll` hooks. At each node:
   - `filter` hooks run first — returning `false` skips the node and its children
   - **Wiki nodes** are directory-only: core mkdirs `childDir` (so the directory exists for items below) and recurses; no file is written for the wiki itself
   - **The root node's mapping onto `contentDir`** (`parentNode === null`) is controlled by the `rootDir` config option (`boolean | string`, default `false`), resolved by `rootFolderSegment(rootDir, title)` in `page_node.ts`:
     - `false` (flat, default): `childDir` is `contentDir` itself — children land directly in `contentDir`, root body → `contentDir/index.<ext>`. A wiki root writes no file.
     - `true`: `childDir` is `contentDir/<slug(realTitle)>` — the root gets its own folder named after its fetched title (the synthetic `"Root"` placeholder is never used for paths).
     - string: `childDir` is `contentDir/<slug(string)>` — a folder with that literal (slugified) name.
     - The root is always treated as a directory-with-index (body → `<childDir>/index.<ext>`), regardless of leaf/non-leaf.
   - **Page nodes** (incl. wiki items) follow the standard rules:
     - Leaf pages → `slug.md` (or title-derived extension if the page title includes one)
     - Pages with children → `slug/index.md`
     - `unchanged` nodes with an existing output file are not rewritten (their plugin `transform`/`onFileWritten` hooks are also skipped)
     - `transform` hooks modify the markdown string before writing
     - `onFileWritten` hooks fire after each file is written
   - Any error from the filter/write/transform/onFileWritten path is sent to `onError`; if suppressed, the node's children still get a chance to run on leaves (non-leaf failures drop descendants — directory with no index is unusable)
7. After each root finishes, the orchestrator compares its old cache slice against the new one and deletes any files whose paths are no longer claimed (page deleted, renamed, or moved in Notion). Cleanup is **scoped per root** — orphans from root A can't touch root B's files. Only paths recorded in that root's previous cache are eligible; anything else in `contentDir` is never touched. Empty parent directories are pruned. Cleanup is gated by the `cleanup` config option (default `true`) and is a no-op when caching is disabled. **Sidecar cleanup is the writing plugin's job:** core cleanup only tracks cache-recorded *page* files, not plugin-written sidecars. The fumadocs preset therefore reconciles its own `meta.json` files in its `afterAll` hook — after (re)writing the current sidebars it removes any `meta.json` under the root that it did not write this run (orphaned by a fully-drafted/deleted/renamed directory) and prunes the emptied dirs (reusing core's exported `pruneEmptyDirs`), gated on `ctx.cleanup`.
8. After every root has finished, the merged cache (`{ version: 2, roots: { [rootId]: { entries: {...} } } }`) is written back to the sidecar JSON file in a single write.

## Incremental sync

When enabled (default), a JSON sidecar file (`.notion-content-gen-cache.json` in `cwd` by default) records each page's `last_edited_time` and resolved output `filePath` between runs. On the next run, pages whose `last_edited_time` and target path are unchanged and whose output file still exists are skipped — no markdown conversion, no file write.

- Toggle via the `cache` config option: `true` (default), `false` (disable), or a string path (custom cache file location).
- The cache file should typically be gitignored locally but persisted between CI runs (e.g. via the CI's cache action) to keep generation fast.
- Cache misses (missing entry, mismatching `last_edited_time`, mismatching path, missing output file, or version bump) fall back to a full sync for that page.
- Cache file is keyed by Notion root id: `{ version: 2, roots: { "<rootId>": { entries: { "<nodeId>": { lastEditedTime, filePath } } } } }`. Multi-root setups share a single cache file and CI cache action; per-root slices are independent.

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

Notion data is promoted to first-class fields on the node — plugins do not
need to reach through nested optional chaining. The `kind` discriminator
lets the tree mix regular pages and wikis transparently:

```ts
type PageNode = {
  kind: "page" | "wiki";

  notionId: string;
  notionTitle: string;                            // updated from the fetched page/database
  parentNode: PageNode | null;
  childNodes: PageNode[];
  filePath?: string;                              // undefined for wiki nodes (directory-only)
  childDir?: string;
  unchanged?: boolean;
  resolvedTitle?: string;
  filtered?: boolean;
  lastEditedTime: string | null;

  // Populated for kind === "page" (incl. wiki items)
  page: PageObjectResponse | null;
  properties: PageObjectResponse["properties"] | null;
  icon: PageObjectResponse["icon"] | null;
  blocks: BlockObjectResponse[];
  mdString: string;
  childPageBlock: ChildPageBlockObjectResponse | null;

  // Populated for kind === "wiki"
  database?: DatabaseObjectResponse | null;
  databaseTitle?: string;
  databaseDescription?: string;
  childDatabaseBlock?: ChildDatabaseBlockObjectResponse | null;
};
```

**Wiki nodes are directory-only.** Core never writes a file for them; their
`filePath` stays `undefined` and `childDir` is set so items below resolve
to the right place. The database description / title / icon hang off the
node as metadata for plugins that want to project them into output (e.g.
sidecar `meta.json`, frontmatter on items, an explicit `index.md` plugin).
If you want an index page inside the wiki, create a wiki item with a title
that slugs to `index` — it lands in the expected place through the normal
slug path.

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

- **`setup({ notion, dryRun, logger })`** — runs **once per generate run** before any Notion API call, regardless of how many roots the config has. Use this to register `notion-to-md` custom transformers, prime caches, or otherwise configure the parser. Plugins run sequentially in declaration order.
- **`beforeAll(tree, ctx)`** — runs **once per root**, after that root's tree is built and before any of its files are written. Plugins receive each root's tree separately. `ctx` is `{ dryRun, cleanup, logger }`.
- **`afterAll(tree, ctx)`** — runs **once per root**, after the last file is written for that root, *in dry-run mode too* so plugins can run validation. Plugins that write sidecar artifacts (e.g. `meta.json`) should guard on `ctx.dryRun`, and if they clean up their own stale sidecars should honor `ctx.cleanup` (the resolved config flag) so their removal respects the same opt-out as core stale-file cleanup.
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

### Wiki recipes

Wikis are auto-detected — no config flag required. Just pass a wiki id as
`notionPageId` (or in a root). A wiki node is directory-only: its database
description and title hang off the node for plugins to consume, but core
writes no file for the wiki itself.

```ts
// Pick up the wiki's description and surface it on every item's frontmatter
{
  name: "wiki-context",
  hooks: {
    transform: async (content, node) => {
      if (node.kind !== "page") return content;
      const wiki = ancestorOfKind(node, "wiki");
      if (!wiki?.databaseDescription) return content;
      return `<!-- from wiki: ${wiki.databaseTitle} — ${wiki.databaseDescription} -->\n${content}`;
    },
  },
}

function ancestorOfKind(node: PageNode, kind: "page" | "wiki") {
  let cur: PageNode | null = node.parentNode;
  while (cur) {
    if (cur.kind === kind) return cur;
    cur = cur.parentNode;
  }
  return null;
}
```

Filter the wiki away entirely if you want to skip its whole subtree:

```ts
{
  name: "skip-handbook",
  hooks: {
    filter: (node) => !(node.kind === "wiki" && node.databaseTitle === "Handbook"),
  },
}
```

Known limitations for wikis:
- Non-wiki pages nested inside wiki items (e.g. a regular page pasted into
  a wiki entry) are not picked up by the database query and won't be
  synced. Move them into the wiki database or use page traversal instead.
- Notion's manual/UI sort order for wiki items is not exposed via the API;
  items come back in the order the data source returns them. Override
  with a `sorts:` argument to `queryAllDataSourceItems` if you need
  deterministic ordering (currently requires a custom parser subclass).

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

### `notion-content-gen/plugins/assets`

Downloads media served from Notion's CDN (behind signed, expiring S3 URLs) and
rewrites the markdown references to durable local paths — or a user-supplied
CDN base — so generated output is self-contained and safe to host statically.

```ts
import { assetsPlugin } from "notion-content-gen/plugins/assets";

assetsPlugin({
  outputDir: "public/notion-assets",   // where bytes land (default "public/notion-assets")
  publicPath: "/notion-assets",         // reference prefix (URL or absolute path); omit for page-relative
  includeExternal: false,               // also pull permanent external URLs (default false)
  blockTypes: ["image", "file", "pdf", "video", "audio"], // default: all five
  concurrency: 4,                       // max concurrent downloads, independent of tree-build (default 4)
  naming: "blockId",                    // "blockId" (default) | "urlHash" | "original"
});
```

**How it works.** Like `mdx-blocks`, it registers `notion-to-md` custom
transformers in `setup` (no new core hook). Each transformer sees the
fully-typed block with its unescaped URL, downloads the bytes through a shared
concurrency-bounded queue, and returns the replacement markdown. Because the
transformer runs *during* `convertBlocksToMarkdown` on the tree-build worker
pool, downloads inherit the existing retry/backoff discipline (`withRetry` is
generalized to accept a fetch-aware retryability predicate).

**Filename stability.** The default `blockId` naming derives the filename from
the (stable) block id plus an extension inferred from the URL *path* — never
the expiring query string — so re-runs are idempotent: if the file is already
on disk the download is skipped. `urlHash` content-addresses by hashing the URL
path; `original` keeps the Notion filename and de-dupes collisions with a short
block-id fragment. Extensions come from the URL path; a path with no extension
yields an extension-less filename.

**Reference resolution.** With `publicPath` set, references become
`${publicPath}/<file>` (final, emitted by the transformer). Without it, the
transformer emits a marker that a `transform` hook rewrites to a path relative
to each page's output file — portable across hosts.

**Dry-run.** Skips the actual download and disk write but still rewrites
references, so `--dry-run` previews correctly.

**Known limitations.**
- **Icons & covers** live on the page object, not the block stream, so they're
  out of scope and left untouched. Handle them in a `transform` pass if needed.
- **Unchanged pages** skip markdown conversion (and this transformer), so a
  hand-deleted asset isn't re-fetched until the page's `last_edited_time`
  changes — mirroring how core skips unchanged page writes.
- **Orphaned assets**: core `cleanupStaleFiles` only tracks page output files,
  so assets for deleted/renamed pages accumulate in `outputDir`. Periodically
  wipe `outputDir` for a clean rebuild (v1 accepts orphan accumulation rather
  than teaching core cleanup about plugin-owned files).

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
- `meta.json` per non-leaf directory, listing child slugs in Notion's order (driven by an `afterAll` hook); the same hook also removes `meta.json` sidecars orphaned since the last run and prunes the emptied directories, gated on `ctx.cleanup`
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

### Single-root (shorthand)

```ts
// notion-content-gen.config.ts
import type { Config } from "notion-content-gen";

const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  notionPageId: "<root-page-id>",     // can be a page id OR a wiki/database id — auto-detected
  contentDir: "content",              // output directory, defaults to "content"
  fileExtension: "md",                // default file extension, defaults to "md"
  cache: true,                        // incremental sync; true (default), false, or custom path
  cleanup: true,                      // delete files for pages removed/renamed in Notion (default true)
  concurrency: 4,                     // max concurrent Notion fetches during tree build (default 4)
  rootDir: false,                     // root→contentDir mapping: false (flat, default) | true (folder named after title) | "name" (literal folder)
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

### Multi-root

`notionPageId` and `roots` are mutually exclusive; supply one or the other.
Each root can be a page or a wiki — the orchestrator probes each one and
dispatches accordingly. Each root gets its own `contentDir` and (optionally)
`fileExtension` / `rootDir`, falling back to the top-level values when omitted.

```ts
const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  contentDir: "content",
  fileExtension: "md",
  cache: true,
  cleanup: true,
  concurrency: 4,
  roots: [
    { notionPageId: "<docs-page-id>",   contentDir: "content/docs" },
    { notionPageId: "<wiki-id>",        contentDir: "content/handbook" },
    { notionPageId: "<blog-page-id>",   contentDir: "content/blog", fileExtension: "mdx" },
  ],
  plugins: [/* shared across all roots */],
};
```

Semantics:
- `setup` fires **once per run**; `beforeAll` / `afterAll` fire **per root**.
- Cleanup is scoped per root — orphans in one root can't touch another root's files.
- Cache file is shared and keyed by root id; CI cache restoration covers every root in one go.
- Roots run sequentially (they typically share a Notion workspace and would otherwise compete for rate limits).
- **Each root must resolve to a distinct output directory** (`contentDir` when flat, `contentDir/<name>` when `rootDir` is set). Two roots landing on the same directory would intermix files, and cross-root slug collisions aren't deduped (slug reservation is per-root), so they'd silently overwrite. Statically-knowable collisions (flat/string `rootDir`) are rejected in `ConfigSchema.superRefine`; `rootDir: true` folders (title-derived, not known until fetch) are checked at run time in `generate()` against the resolved root `childDir`.
