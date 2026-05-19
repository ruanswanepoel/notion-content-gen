import fs from "fs";
import path from "path";
import { slugify } from "./util.js";
import type { PageNode } from "./page_node.js";

type GeneratorConfig = {
  condition?: (node: PageNode) => boolean;
};

export class Generator {
  config: GeneratorConfig;

  constructor({ condition = () => true }: GeneratorConfig) {
    this.config = { condition };
  }

  /**
   * Generates the content (page tree and markdown files) for the given node in the specified directory.
   */
  generateContent(node: PageNode, dir: string) {
    const nodeSlug = slugify(node.notionTitle);
    const newDir = path.join(dir, nodeSlug); // Only relevant if there are childNodes
    let filePath = path.join(dir, `${nodeSlug}.mdx`); // Default filePath, may change if there are childNodes

    if (node.childNodes.length) {
      filePath = path.join(newDir, "index.mdx");

      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }
    }

    // Create the currunt node content
    fs.writeFileSync(filePath, node.notionPage?.mdString?.parent || "");

    // Recursively generate child nodes
    if (node.childNodes) {
      for (let cn of node.childNodes) {
        this.generateContent(cn, newDir);
      }
    }
  }
}
