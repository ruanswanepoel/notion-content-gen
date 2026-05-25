import fs from "fs";
import path from "path";
import { slugify, parseTitleForExtension } from "./util.js";
import type { PageNode } from "./page_node.js";
import type { Plugin } from "./types.js";

type GeneratorConfig = {
  fileExtension?: string;
  plugins?: Plugin[];
};

export class Generator {
  config: Required<GeneratorConfig>;

  constructor({ fileExtension = "md", plugins = [] }: GeneratorConfig) {
    this.config = { fileExtension, plugins };
  }

  generateContent(node: PageNode, dir: string) {
    if (!this.runFilter(node)) return;

    const { baseName, ext } = parseTitleForExtension(node.notionTitle);
    const isLeaf = node.childNodes.length === 0;

    // Title-based extension only applies to leaf files
    const resolvedExt = isLeaf && ext ? ext : this.config.fileExtension;
    const slug = ext ? baseName : slugify(node.notionTitle);
    const newDir = path.join(dir, slug);

    let filePath: string;
    if (isLeaf) {
      filePath = path.join(dir, `${slug}.${resolvedExt}`);
    } else {
      filePath = path.join(newDir, `index.${resolvedExt}`);
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }
    }

    const raw = node.notionPage?.mdString?.parent ?? "";
    const content = this.runTransform(raw, node);
    fs.writeFileSync(filePath, content);
    this.runOnFileWritten(filePath, node);

    for (const child of node.childNodes) {
      this.generateContent(child, newDir);
    }
  }

  private runFilter(node: PageNode): boolean {
    return this.config.plugins.every(
      (plugin) => plugin.hooks?.filter?.(node) ?? true,
    );
  }

  private runTransform(content: string, node: PageNode): string {
    return this.config.plugins.reduce((acc, plugin) => {
      return plugin.hooks?.transform?.(acc, node) ?? acc;
    }, content);
  }

  private runOnFileWritten(filePath: string, node: PageNode): void {
    for (const plugin of this.config.plugins) {
      plugin.hooks?.onFileWritten?.(filePath, node);
    }
  }
}
