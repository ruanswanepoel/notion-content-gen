import fs from "fs";
import path from "path";
import { computeNodeFilePath } from "./util.js";
import type { PageNode } from "./page_node.js";
import type { Plugin } from "./types.js";
import { emptyCache, type CacheData } from "./cache.js";

type GeneratorConfig = {
  fileExtension?: string;
  plugins?: Plugin[];
};

export type GenerationStats = {
  written: number;
  skipped: number;
  filtered: number;
};

export class Generator {
  config: Required<GeneratorConfig>;
  newCache: CacheData = emptyCache();
  stats: GenerationStats = { written: 0, skipped: 0, filtered: 0 };

  constructor({ fileExtension = "md", plugins = [] }: GeneratorConfig) {
    this.config = { fileExtension, plugins };
  }

  generateContent(node: PageNode, dir: string) {
    if (!this.runFilter(node)) {
      this.stats.filtered++;
      return;
    }

    // Prefer the path resolved during tree build; fall back to recomputing in
    // case the tree was built without it.
    let filePath = node.filePath;
    let childDir = node.childDir;
    if (!filePath || !childDir) {
      const resolved = computeNodeFilePath(
        node.notionTitle,
        dir,
        node.childNodes.length > 0,
        this.config.fileExtension,
      );
      filePath = resolved.filePath;
      childDir = resolved.childDir;
    }

    const isLeaf = node.childNodes.length === 0;
    if (!isLeaf && !fs.existsSync(childDir)) {
      fs.mkdirSync(childDir, { recursive: true });
    }

    const lastEditedTime = node.notionPage?.page?.last_edited_time;
    const canSkipWrite = node.unchanged && fs.existsSync(filePath);

    if (canSkipWrite) {
      this.stats.skipped++;
    } else {
      const raw = node.notionPage?.mdString?.parent ?? "";
      const content = this.runTransform(raw, node);
      // Ensure the parent directory exists for leaf files too.
      const parentDir = path.dirname(filePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(filePath, content);
      this.runOnFileWritten(filePath, node);
      this.stats.written++;
    }

    if (lastEditedTime) {
      this.newCache.pages[node.notionId] = { lastEditedTime, filePath };
    }

    for (const child of node.childNodes) {
      this.generateContent(child, childDir);
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
