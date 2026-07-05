# Planned Features

Guiding principles (from [CLAUDE.md](CLAUDE.md)):
- Content sync layer, **not** a site builder
- CI/CD-first, non-interactive `generate`
- Minimal core; opinions live in presets and plugins
- Presets and first-party plugins ship **in-tree** with the core package

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

1. **Webhook-triggered redeploys** — docs-only.

The `assets` plugin (download Notion CDN media, rewrite to local/CDN paths) is
now implemented in-tree at `src/plugins/assets.ts` — see the section in
[CLAUDE.md](CLAUDE.md). It uses `notion-to-md` custom transformers registered
in `setup` (no `transformBlocks` core hook was needed).

Tabular database support (databases-as-content beyond wikis — exposing
arbitrary databases as rows-of-pages rather than tree-of-pages) remains
deferrable.
