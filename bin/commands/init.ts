import path from "path";
import fs from "fs";
import { getPackageType } from "../../src/util.js";

const packageType = getPackageType();

const DEFAULT_JSON_CONFIG = `{
  "notionToken": "NOTION_SECRET",
  "notionPageId": "",
  "contentDir": "content"
}
`;

const DEFAULT_JS_CONFIG = `import 'dotenv/config'
const config = {
  notionToken: process.env.NOTION_SECRET,
  notionPageId: "",
  contentDir: "content",
};
${packageType == "module" ? "export default config;" : "module.exports = config;"}
`;

// TODO: The type here may need to change
const DEFAULT_TS_CONFIG = `import type { Config } from "./src/types";
const config: Config = {
  notionToken: process.env.NOTION_SECRET!,
  notionPageId: "",
  contentDir: "content",
};
export default config;
`;

export async function init(options: { config: string }) {
  const type = options?.config;

  if (!["js", "json", "ts"].includes(type)) {
    console.error("Invalid config type. Use one of: js, json, ts");
    process.exit(1);
  }

  const filename =
    type === "json"
      ? "notion-content-gen.json"
      : `notion-content-gen.config.${type}`;

  const targetPath = path.resolve(process.cwd(), filename);

  if (fs.existsSync(targetPath)) {
    console.error(`${filename} already exists`);
    process.exit(1);
  }

  let contents = "";
  if (type === "json") contents = DEFAULT_JSON_CONFIG;
  if (type === "js") contents = DEFAULT_JS_CONFIG;
  if (type === "ts") contents = DEFAULT_TS_CONFIG;

  fs.writeFileSync(targetPath, contents, "utf-8");

  console.log(`Created file: ${filename}`);
}
