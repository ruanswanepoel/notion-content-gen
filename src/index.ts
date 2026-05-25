import { Generator } from "./generator.js";
import { buildPageTree } from "./page_node.js";
import { NotionParser } from "./notion_parser.js";
import { loadCache, resolveCachePath, saveCache } from "./cache.js";
import { Logger } from "./logger.js";
import type { Config } from "./types.js";

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
    await plugin.hooks?.setup?.({ notion });
  }

  const pageTree = await buildPageTree(config.notionPageId, notion, {
    cache,
    contentDir: config.contentDir,
    fileExtension: config.fileExtension,
    plugins,
  });

  // Generate the content
  const generator = new Generator({
    fileExtension: config.fileExtension,
    plugins,
    dryRun,
    logger,
  });
  await generator.run(pageTree, config.contentDir);

  const { written, skipped, filtered, errored, created, updated } =
    generator.stats;
  const extras = [
    filtered ? `${filtered} filtered` : null,
    errored ? `${errored} errored` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (dryRun) {
    logger.info(
      `Dry run: ${created} would be created, ${updated} would be updated, ${skipped} unchanged${extras ? `, ${extras}` : ""}. No files written.`,
      { created, updated, skipped, filtered, errored, written },
    );
  } else if (cachePath) {
    saveCache(cachePath, generator.newCache);
    logger.info(
      `Done: ${written} written (${created} created, ${updated} updated), ${skipped} unchanged${extras ? `, ${extras}` : ""}. Cache saved to ${cachePath}`,
      { created, updated, skipped, filtered, errored, written, cachePath },
    );
  } else {
    logger.info(
      `Done: ${written} written (${created} created, ${updated} updated), ${skipped} unchanged${extras ? `, ${extras}` : ""}.`,
      { created, updated, skipped, filtered, errored, written },
    );
  }

  return generator.stats;
}

export { Logger } from "./logger.js";
export type { LogLevel, LogFormat } from "./logger.js";
