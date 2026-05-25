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
  index.ts                Orchestrates: builds page tree, then runs generator
  notion_parser.ts        Wraps @notionhq/client + notion-to-md (NotionParser class)
  page_node.ts            Builds the PageNode tree via iterative BFS
  generator.ts            Writes output files recursively from the tree; runs plugin hooks
  types.ts                Shared types, ConfigSchema (Zod), Plugin type
  util.ts                 slugify, parseTitleForExtension, getTreeString, safeStringify, getPackageType
```

## How it works

1. `generate` command calls `loadConfig()` → validates config via `ConfigSchema`, merges `plugins` from raw config
2. `src/index.ts` creates a `NotionParser` and calls `buildPageTree(rootId, notionParser)`
3. `buildPageTree` uses an iterative BFS queue — each node fetches its page content and child pages via `notionParser.retrievePage()`
4. `Generator.generateContent()` recurses the tree, applying plugin hooks at each node:
   - `filter` hooks run first — returning `false` skips the node and its children
   - Leaf pages → `slug.md` (or title-derived extension if the page title includes one)
   - Pages with children → `slug/index.md`
   - `transform` hooks modify the markdown string before writing
   - `onFileWritten` hooks fire after each file is written

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
