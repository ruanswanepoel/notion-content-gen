import { Generator } from "./generator.js";
import { buildPageTree } from "./page_node.js";
import { NotionParser } from "./notion_parser.js";
import {
  cleanupStaleFiles,
  loadCache,
  resolveCachePath,
  saveCache,
} from "./cache.js";
import { Logger } from "./logger.js";
import type { Config } from "./types.js";
import { getTreeString } from "./util.js";

export type GenerateOptions = {
  /** When true, no files are written and no cache is saved. */
  dryRun?: boolean;
  /** Logger used for status output. Defaults to a text-format info-level logger. */
  logger?: Logger;
};

export async function generate(config: Config, options: GenerateOptions = {}) {
  const { dryRun = false, logger = new Logger() } = options;

  logger.debug("Loaded config", {
    notionPageId: config.notionPageId,
    contentDir: config.contentDir,
    fileExtension: config.fileExtension,
    cache: config.cache,
    cleanup: config.cleanup,
    concurrency: config.concurrency,
    plugins: (config.plugins ?? []).map((p) => p.name),
    dryRun,
  });

  const cachePath = resolveCachePath(config.cache);
  const cache = cachePath ? loadCache(cachePath) : undefined;
  if (cachePath) {
    const entries = cache ? Object.keys(cache.pages).length : 0;
    logger.info(
      entries > 0
        ? `Incremental sync enabled — loaded ${entries} cached page(s) from ${cachePath}`
        : `Incremental sync enabled — no prior cache at ${cachePath}, performing full sync`,
    );
  }

  const plugins = config.plugins ?? [];

  // Retrieve the Notion page tree
  const notion = new NotionParser(config.notionToken);

  // Run setup hooks (e.g. n2m custom transformers) before any Notion call.
  for (const plugin of plugins) {
    await plugin.hooks?.setup?.({ notion, dryRun, logger });
  }

  const pageTree = await buildPageTree(config.notionPageId, notion, {
    cache,
    contentDir: config.contentDir,
    fileExtension: config.fileExtension,
    plugins,
    concurrency: config.concurrency,
    logger,
  });

  logger.debug(`Page tree:\n${getTreeString(pageTree)}`);

  // Generate the content
  const generator = new Generator({
    fileExtension: config.fileExtension,
    plugins,
    dryRun,
    logger,
  });
  await generator.run(pageTree, config.contentDir);

  // Stale-file cleanup: anything the previous cache claimed but the new cache
  // no longer does was deleted/renamed/moved in Notion since the last run.
  let cleanupResult = { removed: [] as string[], skipped: [] as string[] };
  if (config.cleanup && cache) {
    cleanupResult = cleanupStaleFiles(cache, generator.newCache, {
      contentDir: config.contentDir,
      dryRun,
      logger,
    });
  }

  const { written, skipped, filtered, errored, created, updated } =
    generator.stats;
  const extras = [
    filtered ? `${filtered} filtered` : null,
    errored ? `${errored} errored` : null,
    cleanupResult.removed.length
      ? `${cleanupResult.removed.length} ${dryRun ? "would be removed" : "removed"}`
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
        wouldRemove: cleanupResult.removed.length,
      },
    );
  } else if (cachePath) {
    saveCache(cachePath, generator.newCache);
    logger.info(
      `Done: ${written} written (${created} created, ${updated} updated), ${skipped} unchanged${extras ? `, ${extras}` : ""}. Cache saved to ${cachePath}`,
      {
        created,
        updated,
        skipped,
        filtered,
        errored,
        written,
        removed: cleanupResult.removed.length,
        cachePath,
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
        removed: cleanupResult.removed.length,
      },
    );
  }

  return { ...generator.stats, removed: cleanupResult.removed.length };
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
  NotionBlock,
  NotionChildPageBlock,
  NotionPageProperty,
  RetrievedPage,
} from "./types.js";
export type { GenerationStats } from "./generator.js";
