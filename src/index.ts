import { Generator } from "./generator.js";
import { buildPageTree } from "./page_node.js";
import { Notion } from "./notion.js";
import type { Config } from "./types.js";

export async function generate(config: Config) {
  console.log(
    "Generating notion content with config: \n\n",
    JSON.stringify(config, null, 2),
  );

  // Retrieve the Notion page tree
  const notion = new Notion(config.notionToken);
  const pageTree = await buildPageTree(config.notionPageId, notion);

  // Generate the content
  const generator = new Generator();
  generator.generateContent(pageTree, config.contentDir);
  // writeMarkdownPageTree(pageTree, config.contentDir);
}
