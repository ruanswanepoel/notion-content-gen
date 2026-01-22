import type { Node } from "./node.js";
import { readFileSync } from "fs";
import { join } from "path";

export function safeStringify(obj: object) {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]"; // or null, or skip
        }
        seen.add(value);
      }
      return value;
    },
    4,
  );
}

export function slugify(str: string) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]+/g, "-") // replace non-alphanumerics with hyphens
    .replace(/^-+|-+$/g, ""); // trim hyphens
}

export function getTreeString(node: Node, depth = 0) {
  let nodeStr = `${"|  ".repeat(depth)}${node.notionTitle}\n`;

  if (node.childNodes?.length) {
    for (const cn of node.childNodes) {
      nodeStr += getTreeString(cn, depth + 1);
    }
  }

  return nodeStr;
}

export function getPackageType(cwd = process.cwd()): "module" | "commonjs" {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return pkg.type === "module" ? "module" : "commonjs";
  } catch {
    return "commonjs"; // Node default
  }
}
