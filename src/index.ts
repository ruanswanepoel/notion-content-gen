import { Generator, type GenerationStats } from "./generator.js";
import { buildPageTree } from "./page_node.js";
import { NotionParser } from "./notion_parser.js";
import {
  cleanupStaleFiles,
  emptyCache,
  loadCache,
  resolveCachePath,
  saveCache,
  type CacheData,
  type CacheRoot,
} from "./cache.js";
import { Logger } from "./logger.js";
import type { Config, NodeKind, RootConfig } from "./types.js";
import { getTreeString } from "./util.js";

export type GenerateOptions = {
  /** When true, no files are written and no cache is saved. */
  dryRun?: boolean;
  /** Logger used for status output. Defaults to a text-format info-level logger. */
  logger?: Logger;
  /**
   * Optional injected NotionParser. Programmatic callers (and tests) can
   * supply a custom instance to swap in a fake or share one across runs.
   * If omitted, a fresh `NotionParser` is constructed from `config.notionToken`.
   */
  notion?: NotionParser;
};

/**
 * Per-root resolution after normalization. Each root has its own contentDir
 * and fileExtension (falling back to top-level defaults) plus the resolved
 * Notion kind (probed once at orchestration time).
 */
type ResolvedRoot = {
  notionPageId: string;
  contentDir: string;
  fileExtension: string;
  rootDir: boolean | string;
};

export async function generate(config: Config, options: GenerateOptions = {}) {
  const { dryRun = false, logger = new Logger() } = options;

  const roots = normalizeRoots(config);

  logger.debug("Loaded config", {
    roots: roots.map((r) => ({
      notionPageId: r.notionPageId,
      contentDir: r.contentDir,
      fileExtension: r.fileExtension,
    })),
    cache: config.cache,
    cleanup: config.cleanup,
    concurrency: config.concurrency,
    plugins: (config.plugins ?? []).map((p) => p.name),
    dryRun,
  });

  const cachePath = resolveCachePath(config.cache);
  const persistedCache: CacheData = cachePath ? loadCache(cachePath) : emptyCache();
  if (cachePath) {
    const entries = Object.values(persistedCache.roots).reduce(
      (sum, r) => sum + Object.keys(r.entries).length,
      0,
    );
    logger.info(
      entries > 0
        ? `Incremental sync enabled — loaded ${entries} cached page(s) across ${Object.keys(persistedCache.roots).length} root(s) from ${cachePath}`
        : `Incremental sync enabled — no prior cache at ${cachePath}, performing full sync`,
    );
  }

  const plugins = config.plugins ?? [];
  const notion = options.notion ?? new NotionParser(config.notionToken);

  // Setup hooks fire once per run — they configure the shared NotionParser
  // (e.g. registering n2m custom transformers).
  for (const plugin of plugins) {
    await plugin.hooks?.setup?.({ notion, dryRun, logger });
  }

  const newPersistedCache: CacheData = emptyCache();
  const aggregateStats: GenerationStats = {
    written: 0,
    skipped: 0,
    filtered: 0,
    errored: 0,
    created: 0,
    updated: 0,
  };
  let aggregateRemoved = 0;

  // Guards against two roots resolving to the same output directory. The
  // schema catches statically-knowable collisions; this also covers
  // `rootDir: true`, whose folder name is only known once the root's title is
  // fetched. Maps effective output dir → the root id that claimed it.
  const claimedDirs = new Map<string, string>();

  // Each root is processed sequentially. They typically share a Notion
  // workspace and would compete for rate limits if run in parallel —
  // sequential is calmer and keeps logs interpretable per-root.
  for (const root of roots) {
    const rootKind: NodeKind = await notion.classifyNode(root.notionPageId);
    logger.info(
      `Syncing root ${root.notionPageId} (${rootKind}) → ${root.contentDir}`,
      {
        notionPageId: root.notionPageId,
        kind: rootKind,
        contentDir: root.contentDir,
      },
    );

    const rootOldCache: CacheRoot | undefined =
      persistedCache.roots[root.notionPageId];

    const pageTree = await buildPageTree(root.notionPageId, notion, {
      cache: rootOldCache,
      contentDir: root.contentDir,
      fileExtension: root.fileExtension,
      plugins,
      concurrency: config.concurrency,
      logger,
      rootKind,
      rootDir: root.rootDir,
    });

    // The root node's resolved `childDir` is this root's effective output
    // directory (contentDir when flat, contentDir/<name> when named). Reject a
    // second root landing on the same one before writing anything.
    const effectiveDir = pageTree.childDir ?? root.contentDir;
    const claimant = claimedDirs.get(effectiveDir);
    if (claimant && claimant !== root.notionPageId) {
      throw new Error(
        `Roots "${claimant}" and "${root.notionPageId}" both write to "${effectiveDir}". Give each root a distinct contentDir or a named rootDir.`,
      );
    }
    claimedDirs.set(effectiveDir, root.notionPageId);

    logger.debug(`Page tree for ${root.notionPageId}:\n${getTreeString(pageTree)}`);

    const generator = new Generator({
      fileExtension: root.fileExtension,
      plugins,
      dryRun,
      logger,
    });
    await generator.run(pageTree, root.contentDir);

    // Stale-file cleanup: anything the previous cache claimed but the new
    // cache no longer does was deleted/renamed/moved in Notion since the
    // last run. Scoped per-root so multi-root setups can't cross over.
    let removedCount = 0;
    if (config.cleanup && rootOldCache) {
      const result = cleanupStaleFiles(rootOldCache, generator.newCache, {
        contentDir: root.contentDir,
        dryRun,
        logger,
      });
      removedCount = result.removed.length;
    }

    newPersistedCache.roots[root.notionPageId] = generator.newCache;

    aggregateStats.written += generator.stats.written;
    aggregateStats.skipped += generator.stats.skipped;
    aggregateStats.filtered += generator.stats.filtered;
    aggregateStats.errored += generator.stats.errored;
    aggregateStats.created += generator.stats.created;
    aggregateStats.updated += generator.stats.updated;
    aggregateRemoved += removedCount;

    logger.debug(
      `Root ${root.notionPageId} stats`,
      { ...generator.stats, removed: removedCount },
    );
  }

  const { written, skipped, filtered, errored, created, updated } =
    aggregateStats;
  const extras = [
    filtered ? `${filtered} filtered` : null,
    errored ? `${errored} errored` : null,
    aggregateRemoved
      ? `${aggregateRemoved} ${dryRun ? "would be removed" : "removed"}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (dryRun) {
    logger.info(
      `Dry run: ${created} would be created, ${updated} would be updated, ${skipped} unchanged${extras ? `, ${extras}` : ""}. No files written.`,
      {
        created,
        updated,
        skipped,
        filtered,
        errored,
        written,
        wouldRemove: aggregateRemoved,
        roots: roots.length,
      },
    );
  } else if (cachePath) {
    saveCache(cachePath, newPersistedCache);
    logger.info(
      `Done: ${written} written (${created} created, ${updated} updated), ${skipped} unchanged${extras ? `, ${extras}` : ""}. Cache saved to ${cachePath}`,
      {
        created,
        updated,
        skipped,
        filtered,
        errored,
        written,
        removed: aggregateRemoved,
        cachePath,
        roots: roots.length,
      },
    );
  } else {
    logger.info(
      `Done: ${written} written (${created} created, ${updated} updated), ${skipped} unchanged${extras ? `, ${extras}` : ""}.`,
      {
        created,
        updated,
        skipped,
        filtered,
        errored,
        written,
        removed: aggregateRemoved,
        roots: roots.length,
      },
    );
  }

  return { ...aggregateStats, removed: aggregateRemoved };
}

/**
 * Resolves the config into an explicit list of roots. Single-root configs
 * (top-level `notionPageId`) and multi-root configs (`roots` array) both
 * normalize to the same shape so the rest of the orchestrator doesn't need
 * to branch.
 *
 * Per-root `contentDir` and `fileExtension` fall back to the top-level
 * config values when omitted on a root. Validation has already ensured
 * exactly one of `notionPageId` / `roots` is supplied.
 */
function normalizeRoots(config: Config): ResolvedRoot[] {
  if (config.roots && config.roots.length > 0) {
    return config.roots.map((root: RootConfig) => ({
      notionPageId: root.notionPageId,
      contentDir: root.contentDir ?? config.contentDir,
      fileExtension: root.fileExtension ?? config.fileExtension,
      rootDir: root.rootDir ?? config.rootDir,
    }));
  }
  if (!config.notionPageId) {
    // Schema validation should have caught this — defensive guard for
    // programmatic callers that bypass `loadConfig`.
    throw new Error(
      "Config must supply either `notionPageId` or a non-empty `roots` array.",
    );
  }
  return [
    {
      notionPageId: config.notionPageId,
      contentDir: config.contentDir,
      fileExtension: config.fileExtension,
      rootDir: config.rootDir,
    },
  ];
}

// Public API surface — plugin authors and programmatic callers should be able
// to get everything they need from `notion-content-gen` without reaching into
// subpath imports.
export { Logger } from "./logger.js";
export type { LogLevel, LogFormat } from "./logger.js";
export { NotionParser } from "./notion_parser.js";
export { getProperty, type PageNode } from "./page_node.js";
export type {
  Config,
  Plugin,
  LifecycleContext,
  SetupContext,
  NotionPage,
  NotionDatabase,
  NotionBlock,
  NotionChildPageBlock,
  NotionChildDatabaseBlock,
  NotionPageProperty,
  NodeKind,
  RetrievedPage,
  RetrievedDatabase,
  RootConfig,
} from "./types.js";
export type { GenerationStats } from "./generator.js";
