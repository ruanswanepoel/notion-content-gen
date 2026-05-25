import { Generator } from "./generator.js";
import { buildPageTree } from "./page_node.js";
import { NotionParser } from "./notion_parser.js";
import { loadCache, resolveCachePath, saveCache } from "./cache.js";
import type { Config } from "./types.js";

export async function generate(config: Config) {
  console.log(
    "Generating notion content with config: \n\n",
    JSON.stringify(config, null, 2),
  );

  const cachePath = resolveCachePath(config.cache);
  const cache = cachePath ? loadCache(cachePath) : undefined;
  if (cachePath) {
    const entries = cache ? Object.keys(cache.pages).length : 0;
    console.log(
      entries > 0
        ? `Incremental sync enabled — loaded ${entries} cached page(s) from ${cachePath}`
        : `Incremental sync enabled — no prior cache at ${cachePath}, performing full sync`,
    );
  }

  const plugins = config.plugins ?? [];

  // Retrieve the Notion page tree
  const notion = new NotionParser(config.notionToken);
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
  });
  await generator.run(pageTree, config.contentDir);

  if (cachePath) {
    saveCache(cachePath, generator.newCache);
    const { written, skipped, filtered, errored } = generator.stats;
    const extras = [
      filtered ? `${filtered} filtered` : null,
      errored ? `${errored} errored` : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `Done: ${written} written, ${skipped} unchanged${extras ? `, ${extras}` : ""}. Cache saved to ${cachePath}`,
    );
  }
}
