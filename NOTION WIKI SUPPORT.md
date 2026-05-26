# Notion Wiki Support — Design & Implementation Plan

## TL;DR

Notion wikis are databases, and — critically — sub-pages of wiki items are
themselves database rows in the same wiki. That means **one paginated
`databases.query` call returns every page in the wiki at any depth**, with
full properties and parent references. We rebuild the hierarchy from those
parent references and then fan out `blocks.children.list` calls in parallel
to fetch each page's content. Roughly `N` total calls vs `2N` for page
traversal, and the wall-clock gap is larger because content fetches all run
at once instead of being gated level-by-level.

The plan: extend the parser to speak the databases API, give `PageNode` a
`kind` discriminator so the tree can be heterogeneous, and let traversal
switch strategy per node. Detect-and-branch is mostly free at runtime —
the parent's block list (for page nodes) or the item's `parent.type`
discriminator (for wiki items) tells us what to do. The only probe required
is at the root of each config root (one extra API call per root, one-time).

This composes naturally with
[Multi-root config](MULTI-ROOT%20CONFIG%20IMPLEMENTATION.md) — each root
independently gets classified as page-tree or wiki, and a single run can
mix the two.

---

## Why bother

1. **Performance — both fewer calls AND better parallelism.** Sub-pages of
   wiki items are themselves wiki items (database rows with `parent.page_id`
   pointing at the parent item). One paginated `databases.query` returns the
   *entire* wiki — every page, every nested sub-page — with full properties.
   We rebuild the hierarchy from `parent` references on the page objects.

   | Strategy                | Calls           | Parallelism |
   |-------------------------|-----------------|-------------|
   | Page traversal          | ~`2N` calls *sequential per level* (block list both reveals children and fetches content) | level-gated — can't fetch a grandchild until parent's blocks return |
   | Wiki query traversal    | `⌈N/100⌉` query calls + `N` block-list calls ≈ **`N`** | structure known upfront — all `N` block-list calls fan out at full concurrency |

   The call-count ratio is ~2×, but wall-clock is better than that because
   page traversal is inherently sequential level-by-level while wiki
   traversal fans out content fetches all at once.
2. **First-class fit for wiki-based docs.** Many docs sites in Notion already
   live in wikis (verified-page workflow, owner/tag properties on every
   page). Treating wikis as second-class — forcing users to fall back to
   manual page links — undersells the tool.
3. **The author wants it.** This repo's own content source is moving to a
   wiki, so the dogfood case is concrete.

---

## What Notion actually exposes (verify before coding)

Confirm each of these against the live Notion API before relying on them in
implementation — Notion's product surface shifts faster than its API docs.

- **A wiki is a database.** Endpoints: `databases.retrieve(id)` and
  `databases.query(id, { start_cursor, page_size, sorts, filter })`.
  `pages.retrieve(wikiId)` will fail with an object-type mismatch (this is
  what gives us cheap root detection — try one, fall back to the other).
- **Wiki items are pages.** Each row returned by `databases.query` is a
  `PageObjectResponse`. Top-level items have `parent.type === "database_id"`
  pointing at the wiki. Sub-pages of items have `parent.type === "page_id"`
  pointing at the parent item. Both shapes go through the existing pipeline
  with no shape change.
- **`databases.query` returns the whole wiki, not just the top level.**
  Wiki sub-pages are themselves rows in the same database. So a single
  paginated query returns every page in the wiki, and we reconstruct the
  hierarchy by walking `parent` references on the returned page objects.
  This is the core perf win — no per-item recursion needed for *structure
  discovery*, only for *content fetch*.
- **Wiki items can have block content.** Same as any Notion page — call
  `blocks.children.list(itemId)` to get the body. This is what we need for
  the markdown conversion. **This is the only remaining O(N) call** for
  wikis.
- **Edge case: non-wiki pages dropped into a wiki item.** If a user pastes
  or drag-drops a regular page into a wiki item, that page may not become a
  wiki database row — it stays as a `child_page` block pointing at a page
  whose parent isn't the wiki database. `databases.query` won't surface it.
  **Decision:** document this as a known limitation in v1 ("wiki traversal
  picks up pages that are part of the wiki database; pages attached via
  non-wiki mechanisms are not synced — move them into the wiki or use page
  traversal instead"). Revisit if anyone hits it. Detecting this would
  require *also* doing `blocks.children.list` discovery on every wiki item
  to compare against the query results, which gives back most of the perf
  win.
- **Wiki items can have `child_database` blocks.** Wikis nested in wikis
  are possible. The nested wiki appears as a `child_database` block in the
  parent item's content, and is a separate database with its own items. Tree
  builder must recurse into databases discovered mid-traversal, not just at
  the config root. (Open question: does `databases.query` on the outer wiki
  return inner-wiki pages too? Probably not, since they have a different
  parent database. Verify during implementation.)
- **Wiki description.** The database object carries a `description` field
  (rich text). This is the natural source for the wiki's `index` content.
- **Order.** `databases.query` sort options are `created_time`,
  `last_edited_time`, or any property. There is **no documented API for
  Notion's manual/UI order** on a wiki. Pick a deterministic default (likely
  `last_edited_time desc` or property-based; configurable) and document it as
  a known limitation that wiki order doesn't match Notion's UI exactly.
- **Empty-titled wiki items.** Wikis allow items with empty `Name`
  properties. We need a fallback slug (e.g. `untitled-<short-id>`) and a
  warning, same as the existing slug-collision path.
- **`is_inline`.** Some wikis surface as inline databases inside a parent
  page; some are standalone. Inline databases appear as `child_database`
  blocks in the parent's block list. The detection path differs slightly
  between the two, so we have to handle both.

---

## Architecture changes

### 1. `NotionParser` gains database methods

New methods on the parser, parallel to the existing page-side surface:

- `retrieveDatabase(id): Promise<DatabaseObjectResponse>` — single
  `databases.retrieve` call, wrapped in `withRetry`. Surfaces the wiki's
  `title`, `description`, `properties` schema, `is_inline`.
- `queryAllDatabaseItems(id, { sorts? }): Promise<PageObjectResponse[]>` —
  paginates `databases.query` until `has_more` is false, same shape as
  `listAllBlockChildren`. Default sort lives here (probably
  `last_edited_time desc`); accept an override from the caller.
- `classifyNode(id): Promise<"page" | "database">` — single-purpose root
  probe. Try `pages.retrieve`; on the appropriate error, try
  `databases.retrieve`; on a different error, surface it. This is the only
  place we ever pay the extra call.

Everything still goes through `withRetry`, so 429/5xx handling stays uniform.

### 2. `PageNode` gets a `kind` discriminator

Today's `PageNode` is implicitly "a page." Make that explicit and additive
so plugin authors don't break:

```ts
export type PageNode = {
  /** "page" = traditional Notion page. "wiki" = Notion database (wiki) root. */
  kind: "page" | "wiki";

  notionId: string;
  notionTitle: string;
  parentNode: PageNode | null;
  childNodes: PageNode[];
  filePath?: string;
  childDir?: string;
  unchanged?: boolean;
  resolvedTitle?: string;
  filtered?: boolean;

  // --- page-kind fields (unchanged for kind === "page") ---
  page: PageObjectResponse | null;
  properties: PageObjectResponse["properties"] | null;
  icon: PageObjectResponse["icon"] | null;
  lastEditedTime: string | null;
  blocks: BlockObjectResponse[];
  mdString: string;
  childPageBlock: ChildPageBlockObjectResponse | null;

  // --- wiki-kind fields (only populated when kind === "wiki") ---
  database?: DatabaseObjectResponse | null;
  /** Database description (rich text) rendered to markdown. Exposed for plugins; core never writes it. */
  databaseDescription?: string;
  /** Database title rich text — convenience field for plugins. */
  databaseTitle?: string;
  /** Source `child_database` block when discovered mid-traversal (null on root). */
  childDatabaseBlock?: ChildDatabaseBlockObjectResponse | null;
};
```

Notes:
- `kind` defaults to `"page"` everywhere old code reads it — `PageNode`
  factories set it explicitly so consumers can switch cleanly.
- Wiki-kind fields are optional. Page-kind plugins (the vast majority) ignore
  them and keep working. Plugins that *want* to react to wikis check
  `node.kind === "wiki"`.
- `properties`, `icon`, `lastEditedTime` stay on every node. For wiki nodes
  these come from the database; for wiki *items* they come from the item's
  page object (which is a regular `PageObjectResponse`, so the rest of the
  pipeline doesn't care).
- A **wiki item** is `kind: "page"`. The wiki itself is `kind: "wiki"`. Items
  are not special — they're just pages whose parent is a database.
- A wiki node is **directory-only**: `childDir` is set, `filePath` is
  `undefined`. Core never emits a file for it. The database description
  and title ride along as metadata for plugins that want to project them
  into output (sidecar `meta.json`, frontmatter on items, etc.). If the
  user wants an actual index page inside the wiki's directory, they create
  a wiki item with a title that slugs to `index` — it lands in the
  expected place through the normal slug path, no special-casing.

### 3. `buildPageTree` becomes kind-aware

The current `visit` does:
1. `notion.retrievePage(id)` → properties, blocks, child pages
2. Resolve path, run filter, convert markdown, enqueue children

The new `visit` does:
1. **Root only:** classify the root via `NotionParser.classifyNode` if
   `kind` isn't already known. (For non-root nodes, the parent's block
   list already told us which kind to expect.)
2. **If `kind === "page"`:** existing flow. When extracting children, look
   at *both* `child_page` *and* `child_database` blocks. `child_page` blocks
   become `kind: "page"` children. `child_database` blocks become
   `kind: "wiki"` children.
3. **If `kind === "wiki"`:** in parallel, `retrieveDatabase` (for
   description + schema) and `queryAllDatabaseItems` (paginated, returns
   *every* page in the wiki at any depth). The description and title hang
   off the wiki node as metadata for plugins — **core does not write an
   index file for the wiki itself.** Then:
   - Build a `Map<parentId, PageObjectResponse[]>` from the query results
     by reading each page's `parent` field.
   - Walk the map starting from the wiki ID — each direct child becomes
     a `kind: "page"` `PageNode` whose `parent` points at the wiki; their
     children come from `parent.page_id === currentItemId` and so on.
   - This entire tree construction happens *without* any further API calls.
     The expensive part is the per-item `blocks.children.list` for content,
     which the existing worker pool fans out at `concurrency` parallelism.
   - Slug reservation and filter hooks still apply per node, in tree order.
   - Items that themselves contain `child_database` blocks → handled when
     we visit them (recurse into the nested wiki via the same branch).

Caching, filter hooks, `onError`, worker-pool concurrency, and
slug-collision handling all stay where they are. The only places they need
to know about `kind` are the few branches above.

#### Path resolution for wikis

A wiki node is **directory-only** — it owns a `childDir` but emits no file
of its own. Wiki items inside become files in that directory. If a wiki
item is titled "index" (slugs to `index`), it naturally becomes
`index.md` and serves as the directory's homepage — but that's the user's
explicit choice, not something core forces.

```
content/
  guides/                ← wiki node (directory only, no file)
    index.md             ← wiki item titled "index" or "Index" (optional, authored by user)
    getting-started.md   ← wiki item (leaf)
    advanced/            ← wiki item with sub-pages
      tuning.md
```

`computeNodeFilePath` needs a tweak: for `kind === "wiki"` nodes, set
`childDir` but leave `filePath` undefined. The generator's write logic
already gates on `filePath`, so a wiki node naturally writes nothing — its
children still resolve their paths relative to `childDir`.

**Empty wiki** (zero items) → empty directory, which the existing
cleanup-empty-dirs pass will prune. No content lost because the wiki's
metadata (description, schema) was never going to be written as a file
without an explicit plugin choosing to project it.

**Plugins that want to project the description into output** do so
explicitly. Examples:
- The fumadocs preset could extend its `_meta.json` writer to include
  `{ title, description }` from wiki nodes (it already walks the tree).
- A plugin could synthesize an `index.md` from `databaseDescription` if
  the user opts in: it'd inspect `node.kind === "wiki"`, write a file at
  `node.childDir + "/index.md"` via `afterAll` or a future block-level
  hook.

### 4. Cache shape — no changes

The cache is keyed by Notion ID and stores `{ lastEditedTime, filePath }`.
Wiki nodes have a Notion ID and a `last_edited_time` (the database's), so
they fit the existing schema with no migration. Wiki items have their own
IDs and edit times — also unchanged.

The multi-root cache restructure (`CacheData.roots[rootId].pages[nodeId]`)
covers both kinds — `pages` here is "cache entries keyed by node ID,"
regardless of whether the node is a page or a wiki. **Rename
`CacheRoot.pages` → `CacheRoot.entries`** in the multi-root work so the name
doesn't lie when wiki support lands. (This is a free rename to do
alongside multi-root before either ships.)

### 5. `Generator` — minimal changes

`Generator.generateContent` is mostly kind-agnostic already. The only
adjustment: wiki nodes have no `filePath`, so the write path is naturally
skipped for them — descend into `childNodes`, but don't write a file for
the wiki itself. The cache logic should still record the wiki node (by ID)
so cleanup correctly tracks "this directory was claimed" via its children's
paths; the wiki's own cache entry can be omitted since there's no file
to compare against on disk.

`onFileWritten`, `transform`, `filter`, `beforeAll`, `afterAll` all keep
working with no signature change. `transform` is never invoked for wiki
nodes (no content to transform); `filter` returning `false` skips the wiki
and its entire subtree.

### 6. Plugin contract & docs

No breaking changes. Additive considerations:

- **Frontmatter plugin** — wiki items have richer properties (Verification,
  Owner, Tags). The existing extractor pattern handles this; just document
  it with examples for wiki property names.
- **`mdx-blocks` plugin** — `child_database` blocks are currently dropped
  by `notion-to-md`. Once the tree builder uses them, plugin authors who
  *post-process* markdown might want a way to know "this directory is a
  wiki." Surfaced via `node.kind` in `transform`.
- **fumadocs preset** — `_meta.json` generation already walks `childNodes`,
  so wiki items appear in the sidebar automatically. Worth extending the
  preset's `_meta.json` writer to pick up `databaseTitle` /
  `databaseDescription` from wiki nodes so the sidebar gets a folder label
  matching what Notion shows. The description/published filter works on
  wiki items (they're pages) without changes.
- **No core "auto-index for wikis."** Users who want an index page in a
  wiki directory create a wiki item titled "index" (or pick a convention
  via their own plugin). Plugins that want to *force* an index from the
  database description can synthesize one in `afterAll` by inspecting
  wiki nodes — but that's a project-specific choice, not a default.

A `filter` returning `false` on a `kind: "wiki"` node skips the entire
wiki subtree, same as for pages. No new hook surface needed.

---

## Multi-root interplay

The multi-root design treats each root as an independent unit: its own
`contentDir`, its own `fileExtension`, its own slice of the cache. Wiki
support fits into this cleanly:

- **Per-root classification.** When iterating roots in
  [src/index.ts](src/index.ts), call `notion.classifyNode(root.notionPageId)`
  once per root, then pass the resolved kind into `buildPageTree`. No
  cross-root coupling.
- **Mixed roots.** A config can have one root pointing at a docs page tree
  and another pointing at a wiki. They write to different `contentDir`s and
  cache independently — the tree builder handles each according to its
  classification.
- **Plugins per root.** Shared. `setup` fires once for the whole run;
  `beforeAll`/`afterAll` fire per root, as agreed in
  [MULTI-ROOT CONFIG IMPLEMENTATION.md](MULTI-ROOT%20CONFIG%20IMPLEMENTATION.md).
  A plugin that only applies to wiki roots can self-gate via
  `tree.kind === "wiki"` inside `beforeAll`.
- **Config surface for kind.** Don't make users declare `kind` in config.
  Detection is cheap (one probe per root) and matches the tool's
  configure-less ethos. *Optional* override for forcing kind would only be
  useful as an escape hatch; defer until requested.

### What if a regular root contains a wiki sub-page?

This is the mixed case and is handled naturally by the detect-during-traversal
design. The block list of an intermediate page contains a `child_database`
block; the tree builder enqueues that ID as a `kind: "wiki"` child, and
when the worker pool visits it, the wiki branch fires. The wiki's items
become further children. No special-case config required.

The output shape:

```
content/
  docs/                     ← regular root
    intro.md
    api/                    ← regular sub-page
      index.md
      handbook/             ← wiki nested inside the regular tree
        index.md            ← wiki description
        request-flow.md     ← wiki item
        auth/               ← wiki item with sub-pages
          index.md
          tokens.md         ← regular sub-page of the wiki item
```

Caching, cleanup, filters, and frontmatter all work uniformly across this
shape because everything still maps to a node ID and a `filePath`.

---

## Detection: how root classification actually works

```ts
async function classifyNode(id: string): Promise<"page" | "database"> {
  try {
    await this.notionClient.pages.retrieve({ page_id: id });
    return "page";
  } catch (err) {
    // Notion returns either object_not_found or validation_error when the
    // ID resolves to a different object type. Both cases indicate "not a
    // page" — try the database endpoint. Any other error is real and
    // should propagate.
    if (!isWrongObjectTypeError(err)) throw err;
    await this.notionClient.databases.retrieve({ database_id: id });
    return "database";
  }
}
```

The exact discrimination on `err.code` needs to be confirmed against the
SDK — Notion's error semantics for wrong-object-type aren't fully crisp in
the docs (could be `validation_error` + a message, or `object_not_found`).
This is the single brittle spot in the whole design, and it needs a real
test against a live workspace, not just docs.

We can also skip the probe and just call `databases.retrieve` first — wikis
are almost certainly the less common case at the *root* level, so probing
pages first is the right default.

For non-root nodes we don't probe at all — the parent's block list told us
the kind.

---

## Effort estimate

Order of magnitude relative to multi-root (which is itself a smallish
afternoon):

| Area                                       | Effort (relative)        |
|--------------------------------------------|--------------------------|
| Parser: database retrieve + query methods  | ~0.5× multi-root         |
| `PageNode.kind` + factories                | ~0.3× multi-root         |
| `buildPageTree` kind-branching             | ~0.7× multi-root         |
| Generator wiki-body wiring                 | ~0.2× multi-root         |
| Detection helper + error matching          | ~0.2× multi-root         |
| Tests (wiki-only, mixed, wiki-in-page)     | ~1.0× multi-root         |
| Docs in CLAUDE.md                          | ~0.3× multi-root         |
| **Total**                                  | **~3× multi-root**       |

Most of the cost is tests, not core logic. The implementation is
mechanically straightforward once `kind` is threaded through `PageNode`.

---

## Implementation order (when this lands)

This is a *plan*, not a green-light to execute. When/if the work starts:

1. Land multi-root first (rename `CacheRoot.pages` → `CacheRoot.entries` as
   part of that work, so wiki support doesn't need a second cache migration).
2. Add `kind` to `PageNode` with default `"page"` everywhere. No behavior
   change; this is a refactor that keeps tests passing.
3. Extend `NotionParser` with `retrieveDatabase`, `queryAllDatabaseItems`,
   `classifyNode`. Cover with parser-level tests against a fake client.
4. Teach `buildPageTree` to branch on `kind`. Extract the wiki visit into a
   helper; reuse all the existing infrastructure (slug reservation,
   filter, cache check, worker pool). Test each scenario:
   - wiki root, flat
   - wiki root, with item sub-pages
   - regular root containing a wiki sub-tree
   - wiki containing a nested wiki
5. Wire `Generator` to use `databaseDescription` for wiki nodes.
6. Update fumadocs preset's `_meta.json` writer to handle wiki nodes
   correctly (probably no change needed, but verify against fixtures).
7. End-to-end test against a real Notion wiki in the author's workspace
   before declaring done.
8. Document in CLAUDE.md: classification behavior, the
   no-config-needed promise, the order-determinism caveat, and the mixed
   structure example.

---

## Open questions & deferred decisions

- **Manual wiki order.** Is there *any* way to retrieve Notion's UI-side
  manual order via the API? If not, surface this as a documented limitation
  and offer a `wikiSort` config option (`{ property?: string, direction:
  "asc" | "desc", timestamp?: ... }`) for users who want explicit control.
- **Wiki item filtering at the database query level.** `databases.query`
  supports `filter` — could push `filter` plugins that gate on Notion
  properties down to the query for free pruning. Defer; the existing
  in-builder filter is correct, and pushing down adds plugin contract
  complexity.
- **Inline databases that aren't wikis.** A `child_database` block could be
  a plain database (not a wiki). Should the tool render those too, or only
  treat verified-page databases as wikis? Decision: treat *any* database
  uniformly — the verification status is a property, not a structural
  signal. If users want to skip non-wiki databases, they can write a
  `filter` plugin checking the database's `is_inline` or a property.
- **Per-database `properties` schema in cache.** If a wiki's schema
  changes, do we want to invalidate item entries? Probably not — page
  `last_edited_time` already reflects property edits. Confirm during
  implementation.
- **Concurrency budget.** A wiki query is cheap, but the N parallel item
  block-fetches happen concurrently. Stays under the existing
  `concurrency` budget. No new knob needed.
