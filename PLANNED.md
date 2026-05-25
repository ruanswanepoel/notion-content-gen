# Planned Features

Guiding principles (from [CLAUDE.md](CLAUDE.md)):
- Content sync layer, **not** a site builder
- CI/CD-first, non-interactive `generate`
- Minimal core; opinions live in presets and plugins
- Presets and first-party plugins ship **in-tree** with the core package

---

## Built-in / Core

### Expose Notion page properties on `PageNode`
Make raw Notion page properties (title, icon, custom properties) available on `PageNode` so plugins and presets have the data they need. This is the foundation for any preset that wants to inject frontmatter or filter by property value — the core tool itself does not write frontmatter.

---

## Plugin system

### Async hooks
Allow `filter`, `transform`, and `onFileWritten` hooks to return `Promise<...>`. Required for hooks that call external APIs, upload assets, or run async linters during generation.

### `beforeAll` / `afterAll` hooks
Hooks that fire once per run, receiving the full page tree. Enables generating `sitemap.json`, search indexes, or a root `_index.md` without a separate post-processing step.

### `onError` hook
Let plugins handle or suppress per-node errors — e.g. skip a page that fails to parse instead of aborting the entire run.

### Documented `filter` hook recipes
Common filtering patterns (draft pages via a `Published` property, title-prefix conventions like 🚧, role-based visibility) should be documented as example uses of the existing `filter` hook rather than built into core. The hook already supports this — only docs and examples are needed.

---

## CLI / Developer Experience

### `--dry-run` flag
Print which files would be written, updated, or deleted without touching disk. Essential for previewing changes in CI before committing output.

### `--verbose` / structured logging
Log level flag with human-readable or JSON-structured output. Useful for debugging large trees, slow fetches, and plugin behaviour in CI pipelines.

---

## First-party plugins (ship in-tree)

Plugins maintained alongside the core package, imported from `notion-content-gen/plugins/*`. They use the same hook API as user plugins — no special access — but live in-tree so they version with the core and serve as canonical examples.

### `assets` plugin
Download images and files from Notion's CDN (which serves expiring URLs) and rewrite references to local paths or a user-supplied CDN base URL. Makes output self-contained and suitable for static hosting. Implemented as a plugin rather than core because it introduces filesystem side effects, URL-rewriting logic, and config (CDN base, output path) that not every consumer needs.

---

## SSG Adapters / Presets (ship in-tree)

Presets are bundles of plugins and config defaults imported from `notion-content-gen/presets/*`. They ship in-tree so they version with the core; if a downstream framework (e.g. Fumadocs) changes its conventions, a single coordinated release updates the preset.

### Frontmatter (general pattern)
Presets and plugins construct and inject frontmatter using Notion page properties exposed on `PageNode` via the `transform` hook. No built-in frontmatter format — the shape is entirely up to the preset or plugin.

### `fumadocs` preset
A named adapter that wires up all Fumadocs-specific behaviour in one import:
- YAML frontmatter (`title`, `description`, `icon`, `full`)
- `_meta.json` generation per directory (preserving Notion's page order for sidebar navigation)
- MDX block transformations (see below)
- Draft filtering via Notion properties

```ts
import { fumadocsPreset } from "notion-content-gen/presets/fumadocs";
```

### MDX block transformations (Fumadocs / MDX consumers)
Opt-in mappings from Notion block types to MDX components, used by the `fumadocs` preset and available to other MDX-based consumers:
- Notion callout → `<Callout type="info|warn|error">`
- Notion toggle → `<Accordion>` / `<Accordions>`
- Notion columns → layout component

---

## Config

### Multiple roots
Accept an array of `notionPageId` entries in config, each with its own `contentDir`. Enables multi-section sites (e.g. `docs/` from one Notion workspace, `blog/` from another) in a single run.

---

## Local development (not CI)

### `watch` command
Re-run generation on a filesystem signal or short timer for local development. Pairs with incremental sync to refetch only changed pages. **Explicitly a dev-mode feature** — CI uses `generate` once at build time. Features added here should not creep into CI workflows.

---

## Documentation (no code required)

### Webhook-triggered redeploys
Document the pattern of wiring Notion webhooks to a Vercel (or equivalent) deploy hook so editor changes trigger a redeploy that re-runs `generate` as part of the build. This is the recommended push-update story and requires no code in this tool — only a docs page with the configuration walkthrough.

---

## Deferred / under explicit scoping

### Database support
Support `notionDatabaseId` alongside `notionPageId` (each database row becomes a file, with row properties mapped to frontmatter). Deferred because Notion databases are tabular, not hierarchical — this is a meaningful expansion of the mental model from "page tree → directory tree." Revisit only when there is concrete user demand, and at that point scope tightly (e.g. only flat database collections under a parent page, not arbitrary relational structures).

---

## Out of scope (intentional)

- **`serve` / long-running webhook listener** — conflicts with non-interactive CI/CD positioning and turns the tool into infrastructure rather than a sync layer. The webhook-triggered redeploy pattern (above) covers the same need without code.
- **`diff` command** — redundant with `--dry-run`, which already answers "what would change?" for CI workflows.
- **Site building, rendering, theming, routing** — explicitly out of scope. Consumers are static site generators; this tool's job ends at writing files.
