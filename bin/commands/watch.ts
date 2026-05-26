import fs from "fs";
import path from "path";
import { loadConfig } from "../config.js";
import { generate as main_generate } from "../../src/index.js";
import { buildLogger, type GenerateCommandOptions } from "./generate.js";

export type WatchCommandOptions = GenerateCommandOptions & {
  interval?: string;
};

const CONFIG_FILES = [
  "notion-content-gen.config.ts",
  "notion-content-gen.config.js",
  "notion-content-gen.json",
];

export async function watch(options: WatchCommandOptions = {}) {
  const logger = buildLogger(options);
  const intervalSec = Math.max(1, parseInt(options.interval ?? "30", 10) || 30);

  let config = await safeLoadConfig(logger, false);
  if (!config) process.exit(1);

  let stopping = false;
  let running = false;
  let pendingRerun = false;
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async (reason: "tick" | "file-change" = "tick") => {
    if (stopping) return;
    if (running) {
      // Coalesce overlapping triggers — one re-run after the current one
      // finishes is plenty.
      pendingRerun = true;
      return;
    }
    running = true;
    try {
      if (reason === "file-change") {
        logger.info("Config or plugin file changed — re-running generate");
      }
      await main_generate(config!, { dryRun: !!options.dryRun, logger });
    } catch (err) {
      // Watch mode must not exit on a single failed run — log and try again
      // on the next trigger. The dev gets feedback in their terminal and can
      // fix the issue (bad config, network blip) without restarting.
      logger.error(
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
      if (pendingRerun && !stopping) {
        pendingRerun = false;
        void runOnce("file-change");
      }
    }
  };

  const cwd = process.cwd();
  const watchedFiles = new Set<string>();
  const watchers: fs.FSWatcher[] = [];

  const watchFile = (file: string) => {
    if (watchedFiles.has(file)) return;
    if (!fs.existsSync(file)) return;
    watchedFiles.add(file);
    try {
      const w = fs.watch(file, { persistent: true }, async () => {
        // Debounce: editors often fire multiple events per save.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          handleFileChange();
        }, 200);
      });
      watchers.push(w);
    } catch (err) {
      logger.debug(
        `Could not watch ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let debounceTimer: NodeJS.Timeout | null = null;
  const handleFileChange = async () => {
    const reloaded = await safeLoadConfig(logger, true);
    if (reloaded) {
      config = reloaded;
      // Re-watch in case the user added a new plugin file.
      watchConfigSources();
    }
    void runOnce("file-change");
  };

  const watchConfigSources = () => {
    // Watch the active config file plus anything it cjs-resolved to. Plugin
    // files imported via `import` won't necessarily show up in require.cache,
    // so also watch JS/TS files that sit next to the config (best-effort).
    for (const name of CONFIG_FILES) {
      watchFile(path.join(cwd, name));
    }
    // Heuristic: watch local files referenced via relative imports in the
    // config text. That keeps a `plugins/my-plugin.js` next to the config
    // file in sync without forcing the user to wire anything up.
    const activeConfig = CONFIG_FILES.map((n) => path.join(cwd, n)).find((p) =>
      fs.existsSync(p),
    );
    if (activeConfig) {
      try {
        const text = fs.readFileSync(activeConfig, "utf-8");
        const importRe = /(?:from\s+|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(text))) {
          const rel = m[1]!;
          const resolved = path.resolve(path.dirname(activeConfig), rel);
          for (const ext of ["", ".ts", ".js", ".mjs", ".cjs"]) {
            const candidate = resolved + ext;
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              watchFile(candidate);
              break;
            }
          }
        }
      } catch {
        /* best-effort */
      }
    }
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    logger.info("Watch stopped");
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  watchConfigSources();

  logger.info(
    `Watch mode — polling Notion every ${intervalSec}s and re-running on config/plugin file changes. Press Ctrl+C to stop.`,
    { intervalSec, dryRun: !!options.dryRun },
  );

  await runOnce();
  timer = setInterval(() => runOnce("tick"), intervalSec * 1000);
}

async function safeLoadConfig(
  logger: ReturnType<typeof buildLogger>,
  bustCache: boolean,
) {
  try {
    return await loadConfig({ bustCache });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}
