#!/usr/bin/env node

import { Command, Option } from "commander";
import { init } from "./commands/init.js";
import { generate } from "./commands/generate.js";
import { watch } from "./commands/watch.js";

const program = new Command();

program
  .name("notion-content-gen")
  .description("Generate static markdown content from Notion")
  .version("0.0.0");

program
  .command("init")
  .description("Initialize notion-content-gen inside a project")
  .option("-c, --config <type>", "Config type: js | json | ts", "js")
  .action(init);

program
  .command("generate")
  .description("Generates the markdown")
  .option(
    "--dry-run",
    "Report which files would be written or updated without touching disk",
  )
  .option("-v, --verbose", "Enable debug-level logging")
  .addOption(
    new Option("--log-format <format>", "Log output format")
      .choices(["text", "json"])
      .default("text"),
  )
  .addOption(
    new Option("--log-level <level>", "Log verbosity").choices([
      "debug",
      "info",
      "warn",
      "error",
      "silent",
    ]),
  )
  .action(generate);

program
  .command("watch")
  .description(
    "Re-run generation on a timer for local development (not for CI)",
  )
  .option(
    "-i, --interval <seconds>",
    "Polling interval between runs, in seconds",
    "30",
  )
  .option(
    "--dry-run",
    "Report which files would be written or updated without touching disk",
  )
  .option("-v, --verbose", "Enable debug-level logging")
  .addOption(
    new Option("--log-format <format>", "Log output format")
      .choices(["text", "json"])
      .default("text"),
  )
  .addOption(
    new Option("--log-level <level>", "Log verbosity").choices([
      "debug",
      "info",
      "warn",
      "error",
      "silent",
    ]),
  )
  .action(watch);

program.parse(process.argv);
