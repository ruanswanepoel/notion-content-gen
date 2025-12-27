import { loadConfig } from "../config.js";
import { generate as main_generate } from "../../src/index.js";

export async function generate() {
  try {
    const config = await loadConfig();
    await main_generate(config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
