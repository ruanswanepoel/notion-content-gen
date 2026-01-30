import { writeMarkdownPageTree } from "./generator.js";
import { buildPageTree } from "./node.js";
import { Notion } from "./notion.js";
import type { Config } from "./types.js";

export async function generate(config: Config) {
  console.log(
    "Generating notion content with config: \n\n",
    JSON.stringify(config, null, 2),
  );

  const notion = new Notion(config.notionToken);
  const pageTree = await buildPageTree(config.notionPageId, notion);
  writeMarkdownPageTree(pageTree, config.contentDir);
}
