import { writeMarkdownPageTree } from "./generator.js";
import { buildPageTree } from "./node.js";
import type { Config } from "./types.js";

export async function generate(config: Config) {
  console.log(
    "Generating notion content with config: \n\n",
    JSON.stringify(config, null, 2),
  );

  const pageTree = await buildPageTree(config.notionPageId);
  writeMarkdownPageTree(pageTree, config.contentDir);
}
