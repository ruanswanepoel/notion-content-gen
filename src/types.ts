import type {
  BlockObjectResponse,
  ChildDatabaseBlockObjectResponse,
  ChildPageBlockObjectResponse,
  DatabaseObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import z from "zod";
import path from "path";
import { slugify } from "./util.js";

// Re-exported SDK types — surfaced here so plugin authors importing from
// `notion-content-gen/types` get the canonical Notion shapes without having
// to depend on `@notionhq/client` directly.
export type NotionBlock = BlockObjectResponse;
export type NotionPage = PageObjectResponse;
export type NotionDatabase = DatabaseObjectResponse;
export type NotionChildPageBlock = ChildPageBlockObjectResponse;
export type NotionChildDatabaseBlock = ChildDatabaseBlockObjectResponse;
export type NotionPageProperty = PageObjectResponse["properties"][string];

// Actual return type of NotionParser.retrievePage
export type RetrievedPage = {
  page: PageObjectResponse;
  blocks: BlockObjectResponse[];
  /** Markdown converted from `blocks`. Empty string when conversion was skipped. */
  mdString: string;
  /** `child_page` blocks extracted from `blocks` for convenience. */
  childPages: ChildPageBlockObjectResponse[];
  /** `child_database` blocks extracted from `blocks` for convenience. */
  childDatabases: ChildDatabaseBlockObjectResponse[];
};

/**
 * Result of querying a wiki/database. Captures the database metadata plus
 * every page returned from its data source(s). Pages may include nested
 * sub-pages — the tree builder reconstructs the hierarchy from each page's
 * `parent` field rather than walking blocks.
 */
export type RetrievedDatabase = {
  database: DatabaseObjectResponse;
  /** All pages in the database, flat. Parent references are intact. */
  items: PageObjectResponse[];
};

// Plugin system
import type { PageNode } from "./page_node.js";
import type { NotionParser } from "./notion_parser.js";
import type { Logger } from "./logger.js";

export type SetupContext = {
  notion: NotionParser;
  /** True when the current generate run was started with `--dry-run`. */
  dryRun: boolean;
  logger: Logger;
};

export type LifecycleContext = {
  /** True when the current generate run was started with `--dry-run`. */
  dryRun: boolean;
  /**
   * The resolved `cleanup` config flag. Plugins that write their own sidecar
   * files (e.g. the fumadocs preset's `meta.json`) should honor it so their
   * cleanup respects the same opt-out as core stale-file removal.
   */
  cleanup: boolean;
  logger: Logger;
};

/**
 * onError handlers return `true` to suppress the error and continue. Any other
 * return value (including a thrown error) causes the error to propagate.
 *
 * - During tree build: a suppressed error drops the failing node (and any of
 *   its undiscovered children) from the tree.
 * - During generation: a suppressed error on a leaf skips the failing node's
 *   file write. A suppressed error on a non-leaf also drops the node's
 *   children from generation — without the parent `index.md` the directory
 *   would be unusable downstream.
 */
export type Plugin = {
  name: string;
  hooks?: {
    /** Fires once before any Notion API call. Use to register custom n2m transformers, etc. */
    setup?: (ctx: SetupContext) => void | Promise<void>;
    /** Fires once before generation starts for a root, after the page tree is built. */
    beforeAll?: (
      tree: PageNode,
      ctx: LifecycleContext,
    ) => void | Promise<void>;
    /** Fires once after all files for a root have been written. */
    afterAll?: (
      tree: PageNode,
      ctx: LifecycleContext,
    ) => void | Promise<void>;
    /** Return `false` to skip the node and its descendants. */
    filter?: (node: PageNode) => boolean | Promise<boolean>;
    /** Receive the markdown string for a node and return a (possibly modified) replacement. */
    transform?: (content: string, node: PageNode) => string | Promise<string>;
    /** Fires after a file is written for a node. */
    onFileWritten?: (filePath: string, node: PageNode) => void | Promise<void>;
    /** Fires when a per-node error occurs. Return `true` to suppress. */
    onError?: (
      err: unknown,
      node: PageNode,
    ) => boolean | void | Promise<boolean | void>;
  };
};

// Per-root overrides. `notionPageId` is the only required field; everything
// else falls back to the top-level config value at normalization time.
const RootSchema = z.object({
  notionPageId: z.string().min(1, "root.notionPageId is required"),
  contentDir: z.string().optional(),
  fileExtension: z.string().optional(),
  rootDir: z.union([z.boolean(), z.string()]).optional(),
});

export type RootConfig = z.infer<typeof RootSchema>;

// External Config
export const ConfigSchema = z
  .object({
    notionToken: z.string().min(1, "notionToken is required"),
    /** Single-root shorthand. Mutually exclusive with `roots`. */
    notionPageId: z.string().min(1).optional(),
    contentDir: z.string().default("content"),
    fileExtension: z.string().default("md"),
    cache: z.union([z.boolean(), z.string()]).default(true),
    /**
     * Whether to delete files for pages removed/renamed in Notion since the last
     * run. Only files the previous cache recorded as ours are eligible; anything
     * else in `contentDir` is left alone. Defaults to `true`. Disable for setups
     * that also write into `contentDir` from other sources.
     */
    cleanup: z.boolean().default(true),
    /**
     * Maximum number of concurrent Notion fetches during tree build. The Notion
     * API limit is ~3 req/sec for integrations, and exceeding it triggers 429s
     * (the built-in retry helper handles those, but lower concurrency is calmer).
     * Defaults to 4.
     */
    concurrency: z.number().int().min(1).max(20).default(4),
    /**
     * How the root maps onto `contentDir`. Per-root overridable.
     * - `false` (default): flat — the root's children land directly in
     *   `contentDir` and the root page's own body writes to
     *   `contentDir/index.<ext>`. No folder named after the root.
     * - `true`: the root gets its own directory named after its real Notion
     *   title (slugified), e.g. `contentDir/<title>/index.<ext>`.
     * - a string: the root gets a directory with that literal name (slugified),
     *   e.g. `rootDir: "handbook"` → `contentDir/handbook/…`.
     */
    rootDir: z.union([z.boolean(), z.string()]).default(false),
    /**
     * Multi-root: a list of independent Notion roots to sync in a single run.
     * Each root gets its own `contentDir` and (optionally) `fileExtension`,
     * falling back to the top-level defaults if omitted. Mutually exclusive
     * with the single-root `notionPageId`.
     */
    roots: z.array(RootSchema).optional(),
  })
  .superRefine((c, ctx) => {
    const hasSingle = !!c.notionPageId;
    const hasMulti = Array.isArray(c.roots) && c.roots.length > 0;
    if (!hasSingle && !hasMulti) {
      ctx.addIssue({
        code: "custom",
        message:
          "Config must supply either `notionPageId` (single root) or a non-empty `roots` array.",
      });
    }
    if (hasSingle && hasMulti) {
      ctx.addIssue({
        code: "custom",
        message:
          "Config cannot supply both `notionPageId` and `roots` — pick one form.",
      });
    }

    // Two roots writing into the same output directory would intermix files,
    // and cross-root slug collisions aren't deduped (slug reservation is
    // per-root), so they'd silently overwrite. Reject that up front. `rootDir:
    // true` names the folder after the (not-yet-fetched) Notion title, so its
    // final directory can't be known here — those are checked at run time in
    // `generate()`; everything statically knowable is checked now.
    if (hasMulti) {
      const seen = new Map<string, number>();
      c.roots!.forEach((r, i) => {
        const rootDir = r.rootDir ?? c.rootDir;
        if (rootDir === true) return; // title-derived — validated at run time
        const contentDir = r.contentDir ?? c.contentDir;
        const dir = rootDir
          ? path.join(contentDir, slugify(rootDir))
          : path.normalize(contentDir);
        const first = seen.get(dir);
        if (first !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["roots", i],
            message: `roots[${first}] and roots[${i}] both write to "${dir}". Give each root a distinct contentDir or a named rootDir.`,
          });
        } else {
          seen.set(dir, i);
        }
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema> & {
  plugins?: Plugin[];
};

/**
 * Per-root strategy resolved during orchestration. Either a regular Notion
 * page (walked via `pages.retrieve` + `blocks.children.list`) or a wiki
 * (walked via `databases.retrieve` + `dataSources.query`).
 */
export type NodeKind = "page" | "wiki";
