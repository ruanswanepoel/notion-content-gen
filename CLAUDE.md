# notion-content-gen

CLI tool that fetches a Notion page tree and writes each page as a static file on disk, preserving the Notion page hierarchy as nested directories.

## Vision & Goals

- **Core purpose**: pull static content from Notion according to its page structure — nothing more. The tool is a content sync layer, not a site builder.
- **Primary use case**: CI/CD pipelines. The `generate` command is designed to run non-interactively in automated environments.
- **Plugin system** (planned): users register hooks that can intercept and modify content during generation — e.g. transforming markdown, injecting frontmatter, or filtering pages.
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
  index.ts                Orchestrates: builds page tree, then runs generator
  notion_parser.ts        Wraps @notionhq/client + notion-to-md — currently being renamed/refactored
  page_node.ts            Builds the PageNode tree via iterative BFS
  generator.ts            Writes output files recursively from the tree
  types.ts                Shared types and ConfigSchema (Zod)
  util.ts                 slugify, getTreeString, safeStringify, getPackageType
```

## How it works

1. `generate` command calls `loadConfig()` → validates config via `ConfigSchema`
2. `src/index.ts` creates a Notion client and calls `buildPageTree(rootId, notion)`
3. `buildPageTree` uses an iterative BFS queue — each node fetches its page content and child pages via `notion.retrievePage()`
4. `Generator.generateContent()` recurses the tree: leaf pages → `slug.md`, pages with children → `slug/index.md`

## In-progress work (branch: `temp`)

Several things are intentionally broken or incomplete as part of an active refactor:

### 1. `notion.ts` → `notion_parser.ts` rename (incomplete)
- File renamed, class renamed `Notion` → `NotionParser`
- `src/index.ts` still imports from `./notion.js` — hasn't been updated yet
- Fix: update import to `./notion_parser.js` and reference `NotionParser`

### 2. `Generator` class refactor (incomplete)
- `writeMarkdownPageTree` (standalone function on `main`) was wrapped into a `Generator` class
- `GeneratorConfig.condition` callback was added but is never applied in `generateContent` — planned filter feature, not yet implemented
- `src/index.ts` still has a commented-out `// writeMarkdownPageTree(...)` call from the old API

### 3. `parsePage` method on `NotionParser` (incomplete)
- `src/notion_parser.ts:48` has `async parsePage` with no signature or body — causes a compile error
- Implementation is pending

### 4. `NcgNotionMetadata` / frontmatter (not yet wired up)
- `NcgNotionMetadata` type and `NotionPageExtended` are defined in `types.ts`
- Nothing reads or sets `ncgMetadata` yet — intended to inject frontmatter into output files

### 5. `Node` → `PageNode` rename (complete)
- `src/node.ts` → `src/page_node.ts`, type `Node` → `PageNode` — done

## Build & type-check

```bash
pnpm check   # tsc --noEmit
pnpm build   # tsc (outputs to dist/)
```

No tests exist yet.

## Config format

```ts
// notion-content-gen.config.ts
const config = {
  notionToken: process.env.NOTION_SECRET!,
  notionPageId: "<root-page-id>",
  contentDir: "content",   // output directory, defaults to "content"
};
export default config;
```
