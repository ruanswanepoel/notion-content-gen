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
  cli.ts                  Commander entrypoint — `init` and `generate` commands
  config.ts               Loads notion-content-gen.config.{ts,js} or .json, validates with Zod
  commands/
    init.ts               Scaffolds a config file
    generate.ts           Thin wrapper: loadConfig() → generate()
src/
  index.ts                Orchestrates: loads cache, builds page tree, runs generator, saves cache
  notion_parser.ts        Wraps @notionhq/client + notion-to-md (NotionParser class)
  page_node.ts            Builds the PageNode tree via iterative BFS; resolves output paths and incremental-sync state
  generator.ts            Writes output files recursively from the tree; runs plugin hooks; reports new cache
  cache.ts                Load/save the `.notion-content-gen-cache.json` sidecar used for incremental sync
  types.ts                Shared types, ConfigSchema (Zod), Plugin type
  util.ts                 slugify, parseTitleForExtension, computeNodeFilePath, getTreeString, safeStringify, getPackageType
```

## How it works

1. `generate` command calls `loadConfig()` → validates config via `ConfigSchema`, merges `plugins` from raw config
2. `src/index.ts` loads the cache (if enabled), creates a `NotionParser`, then calls `buildPageTree(rootId, notionParser, { cache, contentDir, fileExtension })`
3. `buildPageTree` uses an iterative BFS queue — each node fetches its page content and child pages via `notionParser.retrievePage()`. When a cache is provided, retrieval skips markdown conversion, resolves the expected output path, and marks the node `unchanged` if `last_edited_time` + path match the cache and the file still exists. Otherwise the markdown is converted in-place.
4. `Generator.generateContent()` recurses the tree, applying plugin hooks at each node:
   - `filter` hooks run first — returning `false` skips the node and its children
   - Leaf pages → `slug.md` (or title-derived extension if the page title includes one)
   - Pages with children → `slug/index.md`
   - `unchanged` nodes with an existing output file are not rewritten (their plugin `transform`/`onFileWritten` hooks are also skipped)
   - `transform` hooks modify the markdown string before writing
   - `onFileWritten` hooks fire after each file is written
5. After generation, the fresh cache built by the Generator is written back to the sidecar JSON file. Entries for pages that no longer exist are implicitly pruned.

## Incremental sync

When enabled (default), a JSON sidecar file (`.notion-content-gen-cache.json` in `cwd` by default) records each page's `last_edited_time` and resolved output `filePath` between runs. On the next run, pages whose `last_edited_time` and target path are unchanged and whose output file still exists are skipped — no markdown conversion, no file write.

- Toggle via the `cache` config option: `true` (default), `false` (disable), or a string path (custom cache file location).
- The cache file should typically be gitignored locally but persisted between CI runs (e.g. via the CI's cache action) to keep generation fast.
- Cache misses (missing entry, mismatching `last_edited_time`, mismatching path, missing output file, or version bump) fall back to a full sync for that page.

## Plugin system

Plugins are objects with optional hook functions, defined in the config file:

```ts
type Plugin = {
  name: string;
  hooks?: {
    filter?: (node: PageNode) => boolean;
    transform?: (content: string, node: PageNode) => string;
    onFileWritten?: (filePath: string, node: PageNode) => void;
  };
};
```

Plugins are passed through as-is from the config file (not Zod-validated, since functions aren't serialisable). `bin/config.ts` reads `rawConfig.plugins` after Zod validation and merges it into the returned config.

## Incomplete / not yet wired up

### `NcgNotionMetadata` / frontmatter
- `NcgNotionMetadata` type and `NotionPageExtended` are defined in `types.ts`
- Nothing reads or sets `ncgMetadata` yet — intended for injecting frontmatter into output files via a plugin or built-in mechanism

## Build & type-check

```bash
pnpm check   # tsc --noEmit
pnpm build   # tsc (outputs to dist/)
```

No tests exist yet.

## Config format

```ts
// notion-content-gen.config.ts
import type { Config } from "./src/types";

const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  notionPageId: "<root-page-id>",
  contentDir: "content",        // output directory, defaults to "content"
  fileExtension: "md",          // default file extension, defaults to "md"
  cache: true,                  // incremental sync; true (default), false, or custom path
  plugins: [
    {
      name: "my-plugin",
      hooks: {
        filter: (node) => node.notionTitle !== "Draft",
        transform: (content) => `<!-- generated -->\n${content}`,
        onFileWritten: (filePath) => console.log(`Written: ${filePath}`),
      },
    },
  ],
};
export default config;
```
