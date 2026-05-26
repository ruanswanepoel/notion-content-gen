# Multi-root Config — Implementation Handoff

## Task
Implement "Multi-root config" from [PLANNED.md:137-146](PLANNED.md#L137-L146). Accept an array of `notionPageId` entries in config, each with its own `contentDir`. Enables multi-section sites in a single run.

## Key direction from PLANNED.md
- **Implementation note (PLANNED.md:143-146):** "the simplest approach is to keep `Config` as-is and add a top-level orchestrator that runs `generate` once per root. Each root gets its own cache namespace — either separate cache files, or one cache file keyed `{ roots: { rootId: { pages: {...} } } }`. **The latter is friendlier for CI cache restoration.**" → Go with the keyed-single-file approach.
- Listed as last roadmap item (PLANNED.md:186-198), "only when there's user demand" — user is asking now.

## Files already inspected (don't re-read)
- [PLANNED.md](PLANNED.md) — spec
- [CLAUDE.md](CLAUDE.md) — in project context
- [src/types.ts](src/types.ts) — `ConfigSchema`, `Plugin`, `Config`
- [src/index.ts](src/index.ts) — `generate()` orchestrator
- [src/cache.ts](src/cache.ts) — `CacheData`, `loadCache`/`saveCache`, `cleanupStaleFiles`, `CACHE_VERSION = 1`
- [src/page_node.ts](src/page_node.ts) — `buildPageTree`, takes `cache?: CacheData` and uses `cache.pages[id]` at line 203
- [src/generator.ts](src/generator.ts) — `Generator` class, `newCache: CacheData`, writes `newCache.pages[id]` at line 131
- [bin/config.ts](bin/config.ts) — `loadConfig()`, Zod validation flow
- [bin/cli.ts](bin/cli.ts), [bin/commands/init.ts](bin/commands/init.ts), [bin/commands/generate.ts](bin/commands/generate.ts), [bin/commands/watch.ts](bin/commands/watch.ts)
- [tests/fakes.ts](tests/fakes.ts), [tests/cache.test.ts](tests/cache.test.ts), [tests/cleanup.test.ts](tests/cleanup.test.ts), [tests/plugins.test.ts](tests/plugins.test.ts)

## Files not yet read (likely not needed)
- `src/notion_parser.ts`, `src/logger.ts`, `src/util.ts`
- `src/presets/fumadocs.ts`, `src/plugins/*`
- `tests/slug.test.ts`, `tests/pagination.test.ts`

## Planned design

### 1. Config schema ([src/types.ts](src/types.ts))
Backward-compatible. Either top-level `notionPageId` (legacy single-root) **OR** `roots` array — not both, not neither.

```ts
const RootSchema = z.object({
  notionPageId: z.string().min(1),
  contentDir: z.string().default("content"),
  fileExtension: z.string().optional(), // falls back to top-level default if absent
});

export const ConfigSchema = z.object({
  notionToken: z.string().min(1),
  notionPageId: z.string().min(1).optional(),  // was required — now optional
  contentDir: z.string().default("content"),
  fileExtension: z.string().default("md"),
  cache: z.union([z.boolean(), z.string()]).default(true),
  cleanup: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(20).default(4),
  roots: z.array(RootSchema).optional(),
}).superRefine((c, ctx) => {
  const hasSingle = !!c.notionPageId;
  const hasMulti = Array.isArray(c.roots) && c.roots.length > 0;
  if (!hasSingle && !hasMulti) {
    ctx.addIssue({ code: "custom", message: "must supply notionPageId or non-empty roots" });
  }
  if (hasSingle && hasMulti) {
    ctx.addIssue({ code: "custom", message: "supply either notionPageId or roots, not both" });
  }
});
```

`Config` type stays `z.infer<typeof ConfigSchema> & { plugins?: Plugin[] }`.

### 2. Cache structure ([src/cache.ts](src/cache.ts))
Refactor on-disk shape to:
```ts
type CacheEntry = { lastEditedTime: string; filePath: string };
type CacheRoot = { pages: Record<string, CacheEntry> };
type CacheData = { version: number; roots: Record<string, CacheRoot> };  // keyed by Notion root page id
```

**Bump `CACHE_VERSION` to 2.** Existing version-mismatch logic in `loadCache` returns `emptyCache()` on mismatch, so v1 caches silently invalidate → one fresh sync, then back to incremental. Acceptable since cache is just perf.

Keep `CacheRoot` (not raw `Record`) so `buildPageTree`/`Generator` keep their existing `.pages` access pattern:
- `buildPageTree` takes `cache?: CacheRoot | undefined` (per-root slice). page_node.ts:203 `cache.pages[node.notionId]` still works.
- `Generator.newCache: CacheRoot`. generator.ts:131 `this.newCache.pages[node.notionId] = ...` still works.
- `cleanupStaleFiles(oldRoot: CacheRoot, newRoot: CacheRoot, options)` — operates on per-root slices.
- `emptyCache()` for `CacheData` returns `{ version: 2, roots: {} }`. Add helper `emptyRoot(): CacheRoot` returning `{ pages: {} }`.

### 3. Orchestrator ([src/index.ts](src/index.ts))
1. Normalize `config` → array `RootSpec[]` of `{ notionPageId, contentDir, fileExtension }` (apply top-level fileExtension default per root).
2. Create `NotionParser` once.
3. Run `setup` hooks **once** (shared across all roots — they configure the single NotionParser/n2m instance).
4. Load full `CacheData` once at start.
5. For each root (sequential — no parallel because they often share the same Notion workspace and would compete for rate limits):
   - `rootOldCache = persistedCache?.roots[root.notionPageId]`
   - `buildPageTree(root.notionPageId, notion, { cache: rootOldCache, contentDir: root.contentDir, fileExtension: root.fileExtension, plugins, concurrency, logger })`
   - `new Generator({ fileExtension: root.fileExtension, plugins, dryRun, logger })`
   - `await generator.run(pageTree, root.contentDir)` — this fires `beforeAll`/`afterAll` per-root (plugin sees each root's tree separately, which is the most useful semantic — e.g. fumadocs preset writes `_meta.json` per-tree).
   - If `cleanup && rootOldCache`: `cleanupStaleFiles(rootOldCache, generator.newCache, { contentDir: root.contentDir, dryRun, logger })`
   - Stash: `newPersistedCache.roots[root.notionPageId] = generator.newCache`
   - Aggregate stats into a single running total.
6. Save `newPersistedCache` once at end (skip in dry-run, as today).
7. Log per-root info lines so users can trace which root produced what.
8. Return aggregated `GenerationStats` (existing return shape).

**Open semantic decision:** `beforeAll`/`afterAll` fire per-root. `setup` fires once. This is consistent with how the existing single-root contract uses these hooks. Document it in CLAUDE.md.

### 4. Tests
- Update [tests/cache.test.ts](tests/cache.test.ts) and [tests/cleanup.test.ts](tests/cleanup.test.ts) for new `CacheRoot`/`CacheData` shapes.
  - Tests currently build `CacheData` literals like `{ version: 1, pages: {...} }` — these become `CacheRoot` literals (no version field), passed directly to `buildPageTree`/`cleanupStaleFiles`.
- Add `tests/multi-root.test.ts`:
  - Two roots → two content dirs, both populated correctly.
  - Cache is keyed by rootId; per-root cache hit/miss works independently.
  - Cleanup is scoped per-root (deleting a page in root A doesn't touch root B's files).
  - Single-root legacy form still works (back-compat smoke test).
- Existing `tests/plugins.test.ts` uses `buildPageTree` directly and doesn't touch cache — should still pass unchanged if `CacheRoot` is optional like `CacheData` was.

### 5. Docs
- **CLAUDE.md** — add `roots` to the config example and `## Config format` section. Add a "Multiple roots" subsection explaining: per-root `contentDir`/`fileExtension`, shared plugins (with note that `beforeAll`/`afterAll` fire per-root, `setup` once), single cache file keyed by rootId, cleanup scoped per-root.
- **PLANNED.md** — move "Multiple roots" section out of "## Config" into a resolved-summary bullet, and remove the item from "Suggested priority order".

## Implementation order (for next agent)
1. `src/types.ts` — schema + Config type (use superRefine for the either/or validation)
2. `src/cache.ts` — new shapes (`CacheEntry`, `CacheRoot`, `CacheData`), version bump, `emptyCache`/`emptyRoot` helpers, `cleanupStaleFiles` takes `CacheRoot` slices
3. `src/page_node.ts` — change `BuildPageTreeOptions.cache` from `CacheData` to `CacheRoot`
4. `src/generator.ts` — change `newCache` from `CacheData` to `CacheRoot`; import `emptyRoot` (or initialize inline `{ pages: {} }`)
5. `src/index.ts` — `normalizeRoots()` helper + sequential loop, aggregated stats, single cache load/save
6. Update existing tests for new types
7. Add `tests/multi-root.test.ts`
8. Update `CLAUDE.md` (config example + Multiple roots subsection + hook ordering note for per-root lifecycle)
9. Update `PLANNED.md` (move to resolved)
10. `pnpm check && pnpm test`

## Gotchas to watch for
- `loadConfig` in [bin/config.ts:57-60](bin/config.ts#L57) does `{ ...parsed.data, plugins: ... }` — `parsed.data` will now have optional `notionPageId`. Make sure `Config` type accommodates that and downstream consumers don't blindly read `config.notionPageId`.
- The `superRefine` validation in Zod doesn't fire defaults first; double-check that `roots[].contentDir` default of `"content"` applies through validation. If not, apply defaults during normalization in `index.ts`.
- `bin/commands/init.ts` templates have `notionPageId: ""` — leave as-is (single-root is still the default; an empty string still satisfies the new schema as a placeholder once filled in).
- `bin/commands/watch.ts` doesn't need changes — it just reloads config and re-calls `generate()`.
- The `cwd` arg to `resolveCachePath(cache, cwd)` is fine; cache file is global, not per-root.
- `tests/cache.test.ts:142-143` does `gen.newCache.pages.root` — still works under the new shape (`CacheRoot` keeps `.pages`).
- The current `cleanupStaleFiles` signature takes `oldCache: CacheData` and `newCache: CacheData`. The refactored version takes `CacheRoot` slices, so call sites in `src/index.ts` need to pass the per-root slice, and `tests/cleanup.test.ts` literals need `{ pages: {...} }` without the `version`.

## TodoWrite state before interruption
1. ✅ Update Config/ConfigSchema for multi-root — in_progress
2. ⏳ Restructure CacheData to root-keyed shape
3. ⏳ Thread per-root cache slice through buildPageTree and Generator
4. ⏳ Orchestrate multi-root iteration in src/index.ts
5. ⏳ Update existing tests for new CacheData shape
6. ⏳ Add multi-root tests
7. ⏳ Update CLAUDE.md docs and PLANNED.md
8. ⏳ Run pnpm check + pnpm test

No code changes have been written yet — all work is still in planning.
