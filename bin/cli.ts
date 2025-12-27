#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init.js";
import { generate } from "./commands/generate.js";

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
  .action(generate);

program.parse(process.argv);
