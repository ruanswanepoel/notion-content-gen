import fs from "fs";
import path from "path";
import { computeNodeFilePath } from "./util.js";
import type { PageNode } from "./page_node.js";
import type { LifecycleContext, Plugin } from "./types.js";
import { emptyRoot, type CacheRoot } from "./cache.js";
import { Logger } from "./logger.js";

type GeneratorConfig = {
  fileExtension?: string;
  plugins?: Plugin[];
  dryRun?: boolean;
  /** Resolved `cleanup` config flag, surfaced to plugins via LifecycleContext. */
  cleanup?: boolean;
  logger?: Logger;
};

export type GenerationStats = {
  written: number;
  skipped: number;
  filtered: number;
  errored: number;
  created: number;
  updated: number;
};

export class Generator {
  config: Required<Omit<GeneratorConfig, "logger">> & { logger: Logger };
  newCache: CacheRoot = emptyRoot();
  stats: GenerationStats = {
    written: 0,
    skipped: 0,
    filtered: 0,
    errored: 0,
    created: 0,
    updated: 0,
  };

  constructor({
    fileExtension = "md",
    plugins = [],
    dryRun = false,
    cleanup = true,
    logger = new Logger(),
  }: GeneratorConfig) {
    this.config = { fileExtension, plugins, dryRun, cleanup, logger };
  }

  /**
   * Runs the full generation lifecycle: beforeAll → generateContent → afterAll.
   *
   * `afterAll` is still invoked in dry-run mode but receives `dryRun: true` in
   * its context so plugins can branch (skip sidecar writes, but still run
   * validation logic). `onFileWritten` is suppressed entirely in dry-run since
   * no file actually got written.
   */
  async run(rootNode: PageNode, contentDir: string): Promise<void> {
    const ctx: LifecycleContext = {
      dryRun: this.config.dryRun,
      cleanup: this.config.cleanup,
      logger: this.config.logger,
    };
    await this.runBeforeAll(rootNode, ctx);
    await this.generateContent(rootNode, contentDir);
    await this.runAfterAll(rootNode, ctx);
  }

  async generateContent(node: PageNode, dir: string): Promise<void> {
    // The filter pipeline already ran at tree-build time; honor its decision
    // here without re-invoking the hooks (avoids double-running side effects).
    if (node.filtered) {
      this.stats.filtered++;
      return;
    }

    // Wiki nodes are directory-only — they own a childDir but emit no file
    // of their own. Plugins that want to project the database description
    // into output do so explicitly (e.g. via afterAll).
    if (node.kind === "wiki") {
      const childDir = node.childDir ?? dir;
      if (!fs.existsSync(childDir) && !this.config.dryRun) {
        fs.mkdirSync(childDir, { recursive: true });
      }
      for (const child of node.childNodes) {
        await this.generateContent(child, childDir);
      }
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
    if (!isLeaf && !fs.existsSync(childDir) && !this.config.dryRun) {
      fs.mkdirSync(childDir, { recursive: true });
    }

    const lastEditedTime = node.lastEditedTime;
    const canSkipWrite = node.unchanged && fs.existsSync(filePath);

    let wroteOk = true;
    if (canSkipWrite) {
      this.stats.skipped++;
      this.config.logger.debug(`unchanged: ${filePath}`);
    } else {
      try {
        const content = await this.runTransform(node.mdString, node);
        const existed = fs.existsSync(filePath);

        if (this.config.dryRun) {
          this.config.logger.info(
            `[dry-run] would ${existed ? "update" : "create"}: ${filePath}`,
          );
        } else {
          const parentDir = path.dirname(filePath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          fs.writeFileSync(filePath, content);
          await this.runOnFileWritten(filePath, node);
          this.config.logger.debug(
            `${existed ? "updated" : "created"}: ${filePath}`,
          );
        }

        if (existed) this.stats.updated++;
        else this.stats.created++;
        this.stats.written++;
      } catch (err) {
        if (!(await this.runOnError(err, node))) throw err;
        this.stats.errored++;
        wroteOk = false;
      }
    }

    // Only record successful nodes in the new cache so failures retry next run.
    if (lastEditedTime && wroteOk) {
      this.newCache.entries[node.notionId] = { lastEditedTime, filePath };
    }

    // If a non-leaf failed and the error was suppressed, recursing into its
    // children would write files into a directory whose `index` is missing —
    // an unusable broken subtree. Drop the children instead.
    if (!wroteOk && !isLeaf) {
      const dropped = countDescendants(node);
      this.stats.errored += dropped;
      this.config.logger.warn(
        `Skipping ${dropped} descendant(s) of ${node.notionId} because the parent index file was not written.`,
        { notionId: node.notionId, filePath },
      );
      return;
    }

    for (const child of node.childNodes) {
      await this.generateContent(child, childDir);
    }
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

  private async runBeforeAll(
    tree: PageNode,
    ctx: LifecycleContext,
  ): Promise<void> {
    for (const plugin of this.config.plugins) {
      await plugin.hooks?.beforeAll?.(tree, ctx);
    }
  }

  private async runAfterAll(
    tree: PageNode,
    ctx: LifecycleContext,
  ): Promise<void> {
    for (const plugin of this.config.plugins) {
      await plugin.hooks?.afterAll?.(tree, ctx);
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

function countDescendants(node: PageNode): number {
  let n = 0;
  for (const child of node.childNodes) {
    n += 1 + countDescendants(child);
  }
  return n;
}
