import { loadConfig } from "../config.js";
import { generate as main_generate } from "../../src/index.js";
import { Logger, type LogFormat, type LogLevel } from "../../src/logger.js";

export type GenerateCommandOptions = {
  dryRun?: boolean;
  verbose?: boolean;
  logFormat?: LogFormat;
  logLevel?: LogLevel;
};

export function buildLogger(options: GenerateCommandOptions): Logger {
  const level: LogLevel =
    options.logLevel ?? (options.verbose ? "debug" : "info");
  const format: LogFormat = options.logFormat ?? "text";
  return new Logger({ level, format });
}

export async function generate(options: GenerateCommandOptions = {}) {
  const logger = buildLogger(options);
  try {
    const config = await loadConfig();
    await main_generate(config, { dryRun: !!options.dryRun, logger });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
