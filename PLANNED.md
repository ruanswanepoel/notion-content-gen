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

## First-party plugins (ship in-tree)

Plugins maintained alongside the core package, imported from `notion-content-gen/plugins/*`. They use the same hook API as user plugins — no special access — but live in-tree so they version with the core and serve as canonical examples.

### `assets` plugin
Download images and files from Notion's CDN (which serves expiring URLs) and rewrite references to local paths or a user-supplied CDN base URL. Makes output self-contained and suitable for static hosting. Implemented as a plugin rather than core because it introduces filesystem side effects, URL-rewriting logic, and config (CDN base, output path) that not every consumer needs.

---

## Config

### Multiple roots
Accept an array of `notionPageId` entries in config, each with its own `contentDir`. Enables multi-section sites (e.g. `docs/` from one Notion workspace, `blog/` from another) in a single run.

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
