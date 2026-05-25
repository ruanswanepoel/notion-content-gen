import { loadConfig } from "../config.js";
import { generate as main_generate } from "../../src/index.js";
import { buildLogger, type GenerateCommandOptions } from "./generate.js";

export type WatchCommandOptions = GenerateCommandOptions & {
  interval?: string;
};

export async function watch(options: WatchCommandOptions = {}) {
  const logger = buildLogger(options);
  const intervalSec = Math.max(1, parseInt(options.interval ?? "30", 10) || 30);

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let stopping = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async () => {
    if (running || stopping) return;
    running = true;
    try {
      await main_generate(config, { dryRun: !!options.dryRun, logger });
    } catch (err) {
      // Watch mode must not exit on a single failed run — log and try again
      // on the next tick. The dev gets feedback in their terminal and can
      // fix the issue (bad config, network blip) without restarting.
      logger.error(
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    logger.info("Watch stopped");
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  logger.info(
    `Watch mode — re-running every ${intervalSec}s. Press Ctrl+C to stop.`,
    { intervalSec, dryRun: !!options.dryRun },
  );

  await runOnce();
  timer = setInterval(runOnce, intervalSec * 1000);
}
