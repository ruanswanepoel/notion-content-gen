#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("notion-content-gen")
  .description("Generate static markdown content from Notion")
  .version("0.0.0");

program
  .command("init")
  .description("Initialize notion-content-gen inside a project")
  .action(() => {
    //
  });

program
  .command("generate")
  .description("Generates the markdown")
  .action(() => {
    //
  });
