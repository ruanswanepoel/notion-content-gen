import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { ConfigSchema } from "../src/types.js";

const CONFIG_FILES = [
  "notion-content-gen.config.ts",
  "notion-content-gen.config.js",
  "notion-content-gen.json",
];

export async function loadConfig() {
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
    const imported = await import(pathToFileURL(configFile).href);
    rawConfig = imported.default ?? imported;
  }

  const parsed = ConfigSchema.safeParse(rawConfig);

  if (!parsed.success) {
    console.error("Invalid configuration:");
    console.error(parsed.error.format());
    process.exit(1);
  }

  return parsed.data;
}
