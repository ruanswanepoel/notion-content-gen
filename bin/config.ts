import "dotenv/config";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ConfigSchema } from "../src/types.js";
import z from "zod";

const CONFIG_FILES = [
  "notion-content-gen.config.ts",
  "notion-content-gen.config.js",
  "notion-content-gen.json",
];

export type LoadConfigOptions = {
  /**
   * When true, append a unique query string to the import URL so Node's ESM
   * loader re-evaluates the config module instead of returning the cached
   * copy. Used by watch mode to pick up edits to the config or its plugin
   * files without restarting the process.
   */
  bustCache?: boolean;
};

export async function loadConfig(options: LoadConfigOptions = {}) {
  const cwd = process.cwd();

  const configFile = CONFIG_FILES.map((file) => path.join(cwd, file)).find(
    (filePath) => fs.existsSync(filePath),
  );

  if (!configFile) {
    throw new Error(
      `No config file found. Expected one of:\n${CONFIG_FILES.join("\n")}`,
    );
  }

  let rawConfig;

  if (configFile.endsWith(".json")) {
    rawConfig = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  } else {
    const url = options.bustCache
      ? `${pathToFileURL(configFile).href}?v=${Date.now()}`
      : pathToFileURL(configFile).href;
    const imported = await import(url);
    rawConfig = imported.default ?? imported;
  }

  const parsed = ConfigSchema.safeParse(rawConfig);

  if (!parsed.success) {
    console.error("Invalid configuration:");
    console.error(z.prettifyError(parsed.error));
    process.exit(1);
  }

  return {
    ...parsed.data,
    plugins: Array.isArray(rawConfig.plugins) ? rawConfig.plugins : [],
  };
}
