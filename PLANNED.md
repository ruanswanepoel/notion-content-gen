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

These undermine the "trustworthy sync layer" framing and should land before any
new features. They are the difference between a tool that *looks* CI-ready and
one that actually is.

### Block & child-page pagination
[`NotionParser.retrievePage`](src/notion_parser.ts) calls
`blocks.children.list({ block_id })` once and uses the result directly. Notion
paginates at 100 blocks per response — any page with more than 100 blocks
(common for long docs) silently loses content past block 100, and any page with
more than 100 children loses subpages. The cache then memoizes the truncated
output, so subsequent runs reinforce the data loss.

Fix: loop on `has_more` / `start_cursor` until exhausted. Apply the same
treatment anywhere else the SDK paginates (page listings, property values).
This is the single highest-impact correctness bug in the codebase.

### Stale-file cleanup on page deletion
When a Notion page is deleted (or moved, or renamed in a way that changes its
slug), its previously-generated file remains on disk forever. The cache today
only ever *adds* entries — nothing diffs the previous cache against the new
one. For a CI-first tool whose output is published to a static site, this
means deleted pages live on indefinitely.

Fix: after a successful run, compute `oldCache.pages − newCache.pages` and
`fs.rm` each removed file. Be conservative — only delete files that the cache
previously recorded as ours, never anything else in `contentDir`. Consider
gating with a `cleanup: true | false` config flag to opt out for users who
write into `contentDir` from other sources.

### Rate-limit / 429 handling
Notion's documented sustained rate limit is ~3 requests/sec for integrations.
There is no backoff anywhere. A tree of any non-trivial size will eventually
get a 429 mid-build and the entire run will crash. CI runs that succeed today
will start failing as the workspace grows, with no signal until they do.

Fix: wrap `notionClient.*` calls in a retry-with-exponential-backoff helper.
Respect `Retry-After` if Notion sends it. Pairs naturally with bounded
concurrency (next item).

### Bounded concurrency in tree build
[`buildPageTree`](src/page_node.ts) is a sequential BFS — one request in flight
at a time. For 200 pages at ~300ms each, that's a full minute of pure
round-trips before any markdown is written. This is the dominant latency in
practice.

Fix: replace the for-loop with a worker pool of 3–5 concurrent fetches
(dovetails with the ~3 req/s rate limit). Most of the BFS structure stays the
same; only the dispatch changes. Stats and `onError` ordering must remain
deterministic — collect results and merge in tree order.

### Slug collisions silently overwrite
Two sibling pages titled "Setup" both slugify to `setup.md`. The Generator
writes the first, then the second writes over it. The cache keys by Notion ID,
so on the next run both pages claim ownership of the same `filePath` and at
least one will always be `unchanged === false` — the runs never settle.

Fix: detect duplicates per-directory during tree build and pick a strategy
(error out, append `-2`/`-3`, or suffix a short ID). Pick one, document it,
and emit a warning either way so authors know to retitle in Notion.

### `parseTitleForExtension` doesn't slugify the base
[`util.ts:74`](src/util.ts#L74): `const slug = ext ? baseName : slugify(title);`.
When the title has an extension, the base name is taken verbatim — so a page
titled `My Config.json` produces a literal file `My Config.json` (space and
capitalization preserved). Inconsistent with how every other title is handled.

Fix: `const slug = ext ? slugify(baseName) : slugify(title);`.

---

## Architectural improvements

Not bugs, but design smells that make plugins harder to write and the codebase
harder to evolve. The longer they sit, the more user plugins will couple to
their current shape.

### Promote Notion page data onto `PageNode`
The current [`PageNode.notionPage`](src/page_node.ts) shape is derived from
`NotionParser.retrievePage`'s return type:

```ts
notionPage:
  | ({ metadata?: BlockChildrenResponseExtended } & Partial<
      Awaited<ReturnType<typeof NotionParser.prototype.retrievePage>>
    >)
  | null;
```

This leaks the parser's internal return shape into the public type and means
every plugin reaches through partial-everything optional chaining
(`node.notionPage?.page?.properties as any`). The fumadocs preset has to
`as any`-cast its way through every property accessor.

Already on the roadmap as "Expose Notion page properties on `PageNode`" —
flagged here because it's *also* the cleanup that lets a lot of other tech
debt go away.

Fix: promote `properties`, `icon`, `title`, `lastEditedTime` to first-class
fields on `PageNode` with typed shapes. Replace the derived
`notionPage` blob with explicit fields. Provide a typed `getProperty(name)`
helper so plugins don't recreate the `prop.type === "rich_text"` boilerplate
the fumadocs preset has today.

### Delete legacy types
`NcgNotionMetadata`, `NotionPageExtended`, and `BlockChildrenResponseExtended`
in [`src/types.ts`](src/types.ts) are unused. CLAUDE.md already notes they
"linger for backwards-compat callers but aren't read anywhere." The package
is at 0.0.1 — there are no backwards-compat callers. They're confusing the
type surface for no benefit.

Fix: delete them. Use the SDK's `ListBlockChildrenResponse` and narrow with
`block.type === "child_page"` to get a properly typed
`ChildPageBlockObjectResponse` — no double-cast, no custom type.

### Stop double-casting SDK types
[`notion_parser.ts:46`](src/notion_parser.ts#L46) uses
`as unknown as Promise<{ results: BlockChildrenResponseExtended[] }>`. The
`as unknown as` pattern is a sign the type isn't really known — and in this
case the SDK already publishes the correct type.

Fix: lands together with the cleanup above. Use `ListBlockChildrenResponse`
directly and narrow with `block.type === "child_page"`.

### Move `filter` earlier in the pipeline
Today `filter` runs in [`Generator.generateContent`](src/generator.ts), *after*
the page has been fetched and markdown converted. A drafts plugin filtering
out a whole subtree still pays the full fetch + conversion cost for every node
in that subtree.

Fix: run `filter` during tree build, immediately after `retrievePage` returns
(and before `convertBlocksToMarkdown`). If a node is filtered, skip its
markdown conversion *and* skip enqueueing its children. The Generator should
still re-check `filter` (or rely on a flag set during build) so the contract
("filter returning false skips node and descendants") stays consistent.

### `onError` suppression on non-leaf nodes
Suppressing a write error during generation continues into children — but the
parent's `index.md` is now missing, leaving a broken directory in the output.
The current behavior is documented but produces an output that consumers
generally can't use.

Fix: when suppression happens on a non-leaf, skip the children too — or
provide a `filePath`-less placeholder index. Either way, document the choice
prominently in the hook reference. The current asymmetry between tree-build
suppression (drops subtree) and generation suppression (keeps subtree) is
surprising.

### Pass `{ dryRun }` to hooks
`afterAll` is skipped entirely in dry-run because it commonly writes sidecar
files. That breaks plugins that use `afterAll` for *validation* (e.g. "fail
if expected pages are missing") — they get silently disabled.

Fix: still run `afterAll` in dry-run, but pass `{ dryRun: boolean }` as part
of the hook context so plugins can branch. The fumadocs preset's
`writeMetaFiles` becomes `if (!ctx.dryRun) writeMetaFiles(tree)`. Same context
object is a natural place to add `logger` and `config` later.

### Watch mode: file-watch config + plugin code
The watch loop polls Notion on a timer but doesn't react to local file changes.
A developer iterating on a plugin or config has to Ctrl+C and restart to pick
up changes. For a "local dev only" command, that's the wrong default.

Fix: also watch `notion-content-gen.config.*` (and ideally the plugin files
it imports) for changes, and re-run on save. Falls back to the timer for
Notion-side changes.

---

## Small fixes

Low-risk, mechanical changes that should ride along with the next refactor.

- **`init` TS template** [(`init.ts:24`)](bin/commands/init.ts#L24) imports
  `./src/types` — wrong for end users. Should be
  `import type { Config } from "notion-content-gen/types"`. The existing TODO
  already flags this.
- **CLI version hardcoded** [(`cli.ts:13`)](bin/cli.ts#L13) shows `"0.0.0"`
  while `package.json` is `0.0.1`. Read from `package.json` at build time
  (or via a generated constant).
- **Main entry barely re-exports anything.** [`src/index.ts`](src/index.ts)
  only re-exports `Logger`. Plugin authors importing
  `from "notion-content-gen"` get nothing useful — they have to reach into
  `notion-content-gen/types`. Re-export `Plugin`, `PageNode`, `Config`,
  `GenerationStats`, and the hook context types from the main entry.
- **Dead utilities.** `safeStringify` in [`util.ts`](src/util.ts) is unused;
  `getTreeString` is unused outside of intended-but-unwired debug logging.
  Either wire `getTreeString` into `--verbose`
  (`logger.debug(getTreeString(tree))` after build, gated by level) or delete
  both.
- **Synthetic "Root" node.** The root is created with `notionTitle: "Root"`
  and never updated after the real page is fetched. The fumadocs preset
  already has to special-case `parentNode === null`. Either update
  `notionTitle` from the fetched page, or document the convention clearly so
  preset authors stop reinventing the special case.
- **Hook ordering note for presets.** Plugins fire in config-declaration
  order. Presets that return `Plugin[]` (like `fumadocsPreset`) put the user's
  plugins before or after the preset's depending on spread position. Worth a
  one-line note in the preset docs so users understand why a `transform` runs
  before or after frontmatter injection.

---

## Testing

There are zero tests. The plugin pipeline — `transform` chaining, `filter`
short-circuit, cache invalidation, dry-run no-write guarantee, `onError`
suppression behavior — is exactly the kind of deterministic logic that
snapshot/unit tests cover well. Without them, a refactor in `Generator` will
silently break first-party presets.

Suggested initial coverage (ten or so tests, enough to defend the plugin
contract):

- Cache hit: unchanged page is not rewritten, file content is preserved.
- Cache miss: changed `last_edited_time` triggers a rewrite.
- Cache miss: missing output file triggers a rewrite even if `last_edited_time`
  matches.
- Filter short-circuit: returning `false` skips node and all descendants.
- Transform chaining: each plugin receives the previous plugin's output.
- Dry-run: no file writes, no cache save, but `beforeAll`/`filter`/`transform`
  still run.
- `onError` suppression during tree build drops the node from its parent.
- `onError` suppression during generation increments `errored` and continues
  into children.
- Slug collision: behaves per documented strategy (once decided).
- Pagination: a mocked >100-block response is fully consumed.

A small test harness around a fake `NotionParser` (returning canned
`RetrievedPage` shapes) is enough — no Notion network required.

---

## Built-in / Core (existing roadmap)

### Expose Notion page properties on `PageNode`
See [Promote Notion page data onto `PageNode`](#promote-notion-page-data-onto-pagenode)
above. This is the foundation for any preset that wants to inject frontmatter
or filter by property value — the core tool itself does not write frontmatter.

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

### Multiple roots
Accept an array of `notionPageId` entries in config, each with its own
`contentDir`. Enables multi-section sites (e.g. `docs/` from one Notion
workspace, `blog/` from another) in a single run.

Implementation note: the simplest approach is to keep `Config` as-is and add
a top-level orchestrator that runs `generate` once per root. Each root gets
its own cache namespace — either separate cache files, or one cache file
keyed `{ roots: { rootId: { pages: {...} } } }`. The latter is friendlier for
CI cache restoration.

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

A recommended sequence, weighted by user-visible pain rather than category.
Items 1–3 are blockers for honestly claiming "CI-ready"; items 4–6 are the
foundation everything else builds on.

1. **Block & child-page pagination** — silent data loss is the worst possible
   failure mode for a sync tool. Quick to fix, high-impact.
2. **Stale-file cleanup** — required to claim the CI/CD story without
   asterisks.
3. **Rate-limit handling + bounded concurrency** — implement together. Without
   these, the tool fails on real-world workspaces.
4. **Promote Notion properties onto `PageNode`** (+ delete legacy types and
   SDK double-casts in the same pass). Unlocks cleaner presets and pays down
   the largest chunk of type debt in one move.
5. **Slug collision detection.** Cheap; prevents another class of silent
   overwrites.
6. **Initial test harness** covering the plugin contract. Locks in the work
   above before the user-facing plugin API has to absorb breaking changes.

Multi-root and database support are deferrable until 1–6 land — neither
solves a problem an existing user actually has, while 1–3 are blockers for
trust.
