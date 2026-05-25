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
  errored: number;
};

export class Generator {
  config: Required<GeneratorConfig>;
  newCache: CacheData = emptyCache();
  stats: GenerationStats = {
    written: 0,
    skipped: 0,
    filtered: 0,
    errored: 0,
  };

  constructor({ fileExtension = "md", plugins = [] }: GeneratorConfig) {
    this.config = { fileExtension, plugins };
  }

  /**
   * Runs the full generation lifecycle: beforeAll → generateContent → afterAll.
   */
  async run(rootNode: PageNode, contentDir: string): Promise<void> {
    await this.runBeforeAll(rootNode);
    await this.generateContent(rootNode, contentDir);
    await this.runAfterAll(rootNode);
  }

  async generateContent(node: PageNode, dir: string): Promise<void> {
    let keep: boolean;
    try {
      keep = await this.runFilter(node);
    } catch (err) {
      if (!(await this.runOnError(err, node))) throw err;
      this.stats.errored++;
      return;
    }
    if (!keep) {
      this.stats.filtered++;
      return;
    }

    // Prefer the path resolved during tree build; fall back to recomputing.
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

    let wroteOk = true;
    if (canSkipWrite) {
      this.stats.skipped++;
    } else {
      try {
        const raw = node.notionPage?.mdString?.parent ?? "";
        const content = await this.runTransform(raw, node);
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(filePath, content);
        await this.runOnFileWritten(filePath, node);
        this.stats.written++;
      } catch (err) {
        if (!(await this.runOnError(err, node))) throw err;
        this.stats.errored++;
        wroteOk = false;
      }
    }

    // Only record successful nodes in the new cache so failures retry next run.
    if (lastEditedTime && wroteOk) {
      this.newCache.pages[node.notionId] = { lastEditedTime, filePath };
    }

    for (const child of node.childNodes) {
      await this.generateContent(child, childDir);
    }
  }

  private async runFilter(node: PageNode): Promise<boolean> {
    for (const plugin of this.config.plugins) {
      const filter = plugin.hooks?.filter;
      if (!filter) continue;
      const result = await filter(node);
      if (result === false) return false;
    }
    return true;
  }

  private async runTransform(content: string, node: PageNode): Promise<string> {
    let result = content;
    for (const plugin of this.config.plugins) {
      const transform = plugin.hooks?.transform;
      if (!transform) continue;
      result = await transform(result, node);
    }
    return result;
  }

  private async runOnFileWritten(
    filePath: string,
    node: PageNode,
  ): Promise<void> {
    for (const plugin of this.config.plugins) {
      await plugin.hooks?.onFileWritten?.(filePath, node);
    }
  }

  private async runBeforeAll(tree: PageNode): Promise<void> {
    for (const plugin of this.config.plugins) {
      await plugin.hooks?.beforeAll?.(tree);
    }
  }

  private async runAfterAll(tree: PageNode): Promise<void> {
    for (const plugin of this.config.plugins) {
      await plugin.hooks?.afterAll?.(tree);
    }
  }

  private async runOnError(err: unknown, node: PageNode): Promise<boolean> {
    let suppressed = false;
    for (const plugin of this.config.plugins) {
      const handler = plugin.hooks?.onError;
      if (!handler) continue;
      try {
        if ((await handler(err, node)) === true) suppressed = true;
      } catch {
        // Errors inside onError handlers are swallowed so one bad handler
        // can't mask the original failure or break the loop.
      }
    }
    return suppressed;
  }
}
