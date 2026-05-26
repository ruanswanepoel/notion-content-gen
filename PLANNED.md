# Planned Features

Guiding principles (from [CLAUDE.md](CLAUDE.md)):
- Content sync layer, **not** a site builder
- CI/CD-first, non-interactive `generate`
- Minimal core; opinions live in presets and plugins
- Presets and first-party plugins ship **in-tree** with the core package

Items are grouped by category, not strictly by priority. A suggested execution
order is given at the bottom under [Suggested priority order](#suggested-priority-order).

---

## Critical bugs & gaps (block the CI/CD story)

All items in this section have been resolved. See git history for the
implementation details. Summary of what landed:

- **Block & child-page pagination** —
  [`NotionParser.listAllBlockChildren`](src/notion_parser.ts) loops on
  `has_more`/`next_cursor` until exhausted; pages with >100 blocks or >100
  children are fully consumed.
- **Stale-file cleanup on page deletion** —
  [`cleanupStaleFiles`](src/cache.ts) diffs old vs. new cache after a
  successful run and removes orphaned files (page deleted, renamed, or moved).
  Only paths the previous cache recorded are eligible; anything else in
  `contentDir` is left alone. Gated by the `cleanup` config option (default
  `true`). Empty parent directories are pruned.
- **Rate-limit / 429 handling** — every Notion call goes through
  [`withRetry`](src/retry.ts) — exponential backoff with full jitter,
  respects `Retry-After`, also retries 5xx and transient network errors.
- **Bounded concurrency in tree build** —
  [`buildPageTree`](src/page_node.ts) now runs a worker-pool BFS with default
  concurrency 4 (configurable via the `concurrency` config option, range 1–20).
  Stats and child-order remain deterministic regardless of worker scheduling.
- **Slug collisions** — sibling slugs are reserved per-directory at
  parent-visit time (in Notion's child order, before children are dispatched),
  so collisions get deterministic `-2`/`-3`/… suffixes regardless of worker
  scheduling. A warning is logged so authors know to retitle in Notion.
- **`parseTitleForExtension`** — `computeNodeFilePath` now slugifies the
  base name when the title carries an explicit extension, matching how every
  other title is handled.

---

## Architectural improvements

All items in this section have been resolved. Summary of what landed:

- **`PageNode` first-class fields** — `properties`, `icon`, `lastEditedTime`,
  `page`, `blocks`, `mdString`, `childPageBlock` now live directly on
  [`PageNode`](src/page_node.ts). The derived `notionPage` blob is gone; the
  legacy `NcgNotionMetadata`, `NotionPageExtended`, and
  `BlockChildrenResponseExtended` types in `types.ts` are deleted. A
  `getProperty(node, name)` helper (exported from the main entry) replaces the
  `as any` chain that the fumadocs preset used.
- **No more SDK double-casts** — `listAllBlockChildren` consumes
  `ListBlockChildrenResponse` directly and uses `isFullBlock` to narrow.
- **`filter` runs during tree build** — immediately after `retrievePage`
  returns, before markdown conversion and before children are enqueued.
  A filtered node sets a `filtered` flag that the Generator honors; its
  descendants are never even fetched. Filter contract is unchanged.
- **`onError` non-leaf suppression** — when a write error is suppressed on a
  page with children, the children are now skipped as well (and counted into
  `errored`). A directory with a missing `index` is unusable downstream, so
  the asymmetry is gone.
- **`{ dryRun, logger }` hook context** — `beforeAll` / `afterAll` / `setup`
  now receive a context object. `afterAll` runs in dry-run too so validation
  plugins fire; the fumadocs preset's `_meta.json` writer guards on
  `ctx.dryRun`. `onFileWritten` remains suppressed in dry-run.
- **Watch mode file-watching** — the watch command now `fs.watch`es the active
  config file plus any local files referenced via relative imports in the
  config, busting the ESM module cache when reloading so plugin edits take
  effect without a restart.

---

## Small fixes

All resolved:

- **`init` TS template** now imports from `"notion-content-gen"`.
- **CLI version** read from `package.json` at runtime via `getOwnPackageVersion`.
- **Main entry re-exports** `Plugin`, `PageNode`, `Config`,
  `GenerationStats`, `LifecycleContext`, `SetupContext`, `getProperty`,
  `NotionParser`, plus the Notion type aliases.
- **Dead utilities** — `safeStringify` deleted; `getTreeString` wired into
  the orchestrator's debug log.
- **Synthetic Root node** — `notionTitle` is updated from the fetched page so
  presets see a real title; the `parentNode === null` convention for
  identifying the root is documented in [CLAUDE.md](CLAUDE.md).
- **Hook ordering note for presets** documented in [CLAUDE.md](CLAUDE.md).

---

## Testing

A test harness now lives in [`tests/`](tests/) and runs via
`pnpm test` (Node's built-in test runner + a fake `NotionParser`).
Initial coverage matches the items the plugin contract needs to defend:

- Cache hit / miss (changed time, missing file, disabled) — `tests/cache.test.ts`
- Filter short-circuit (with descendants not fetched) — `tests/plugins.test.ts`
- Transform chaining — `tests/plugins.test.ts`
- Dry-run no-write + `afterAll` ctx — `tests/plugins.test.ts`
- `onError` tree-build vs generation, leaf vs non-leaf — `tests/plugins.test.ts`
- Sibling slug collision + extension titles — `tests/slug.test.ts`
- `cleanupStaleFiles` (owned-only, escape-safe, prune-dirs, dry-run) — `tests/cleanup.test.ts`
- Block pagination cursor walk — `tests/pagination.test.ts`

---

## First-party plugins (ship in-tree)

Plugins maintained alongside the core package, imported from
`notion-content-gen/plugins/*`. They use the same hook API as user plugins —
no special access — but live in-tree so they version with the core and serve
as canonical examples.

### `assets` plugin
Download images and files from Notion's CDN (which serves expiring URLs) and
rewrite references to local paths or a user-supplied CDN base URL. Makes
output self-contained and suitable for static hosting. Implemented as a plugin
rather than core because it introduces filesystem side effects, URL-rewriting
logic, and config (CDN base, output path) that not every consumer needs.

Note: the cleanest implementation will want a block-level hook (operating on
raw Notion blocks before markdown conversion) rather than a string-level
`transform`. Worth considering whether to add a `transformBlocks` hook
alongside the existing `transform`, or to lean on `notion-to-md` custom
transformers as the fumadocs `mdx-blocks` plugin does.

---

## Config

Resolved items kept here as a record of what landed.

### Multiple roots — DONE
Accepted: top-level `roots` array (mutually exclusive with `notionPageId`),
each with its own `contentDir` and optional `fileExtension`. Cache is shared
across roots as a single sidecar file keyed by root id
(`{ version: 2, roots: { [rootId]: { entries: {...} } } }`). Cleanup is
scoped per-root. `setup` hooks fire once per run; `beforeAll` / `afterAll`
fire once per root. Roots run sequentially. Design archived in
[MULTI-ROOT CONFIG IMPLEMENTATION.md](MULTI-ROOT%20CONFIG%20IMPLEMENTATION.md).

### Notion wiki support — DONE
Wikis are first-class. `PageNode` carries a `kind: "page" | "wiki"`
discriminator; the tree builder uses `databases.retrieve` +
`dataSources.query` for wiki nodes and reconstructs hierarchy from each
returned page's `parent` field rather than walking blocks. Wiki nodes are
directory-only (no auto-index file); the database title/description hang
off the node as metadata for plugins to project as they see fit. The
orchestrator probes each root once via `NotionParser.classifyNode` to
decide how to walk it, and `child_database` blocks discovered mid-traversal
become wiki sub-nodes (so wikis can be nested inside regular pages).
Design archived in [NOTION WIKI SUPPORT.md](NOTION%20WIKI%20SUPPORT.md).

---

## Documentation (no code required)

### Webhook-triggered redeploys
Document the pattern of wiring Notion webhooks to a Vercel (or equivalent)
deploy hook so editor changes trigger a redeploy that re-runs `generate` as
part of the build. This is the recommended push-update story and requires no
code in this tool — only a docs page with the configuration walkthrough.

---

## Deferred / under explicit scoping

### Database support
Support `notionDatabaseId` alongside `notionPageId` (each database row becomes
a file, with row properties mapped to frontmatter). Deferred because Notion
databases are tabular, not hierarchical — this is a meaningful expansion of
the mental model from "page tree → directory tree." Revisit only when there
is concrete user demand, and at that point scope tightly (e.g. only flat
database collections under a parent page, not arbitrary relational
structures).

---

## Out of scope (intentional)

- **`serve` / long-running webhook listener** — conflicts with
  non-interactive CI/CD positioning and turns the tool into infrastructure
  rather than a sync layer. The webhook-triggered redeploy pattern (above)
  covers the same need without code.
- **`diff` command** — redundant with `--dry-run`, which already answers
  "what would change?" for CI workflows.
- **Site building, rendering, theming, routing** — explicitly out of scope.
  Consumers are static site generators; this tool's job ends at writing files.

---

## Suggested priority order

The CI-readiness blockers, the `PageNode` property promotion, the
architectural improvements, the small fixes, and the initial test harness
have all landed. What's left on the roadmap is the genuinely new work:

Multi-root and Notion wiki support both shipped on the same branch (the
`PageNode.kind` refactor + cache rename happened once). What's left on the
roadmap:

1. **`assets` plugin** (download Notion CDN images, rewrite to local paths).
   Probably wants a `transformBlocks` hook so it can run on raw blocks rather
   than post-conversion markdown.
2. **Webhook-triggered redeploys** — docs-only.

Tabular database support (databases-as-content beyond wikis — exposing
arbitrary databases as rows-of-pages rather than tree-of-pages) remains
deferrable.
