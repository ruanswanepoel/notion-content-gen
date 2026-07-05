import type { PageNode } from "./page_node.js";
import { readFileSync } from "fs";
import path, { join } from "path";

export function slugify(str: string) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]+/g, "-") // replace non-alphanumerics with hyphens
    .replace(/^-+|-+$/g, ""); // trim hyphens
}

/**
 * Renders a `PageNode` tree as an indented string for debug output. Filtered
 * nodes are marked with a trailing `(filtered)`.
 */
export function getTreeString(node: PageNode, depth = 0) {
  const marker = node.filtered ? " (filtered)" : "";
  let nodeStr = `${"|  ".repeat(depth)}${node.notionTitle}${marker}\n`;

  if (node.childNodes?.length) {
    for (const cn of node.childNodes) {
      nodeStr += getTreeString(cn, depth + 1);
    }
  }

  return nodeStr;
}

/**
 * If the title ends with a file extension (e.g. "meta.json"), returns the base name and extension separately.
 * Otherwise returns the original title with a null extension, leaving slugification to the caller.
 */
export function parseTitleForExtension(title: string): {
  baseName: string;
  ext: string | null;
} {
  const match = title.match(/^(.+)\.([a-zA-Z0-9]+)$/);
  if (match) {
    return { baseName: match[1]!, ext: match[2]! };
  }
  return { baseName: title, ext: null };
}

/**
 * Computes the output file path and child directory for a page based on its
 * title, parent directory, whether it has children, and the default extension.
 *
 * Mirrors the resolution rules used by the Generator so they can be applied
 * up front during tree construction (e.g. for cache lookups).
 */
export function computeNodeFilePath(
  title: string,
  parentDir: string,
  hasChildren: boolean,
  defaultExtension: string,
): { filePath: string; childDir: string } {
  const { baseName, ext } = parseTitleForExtension(title);
  const isLeaf = !hasChildren;
  const resolvedExt = isLeaf && ext ? ext : defaultExtension;
  const slug = ext ? slugify(baseName) : slugify(title);
  const childDir = path.join(parentDir, slug);
  const filePath = isLeaf
    ? path.join(parentDir, `${slug}.${resolvedExt}`)
    : path.join(childDir, `index.${resolvedExt}`);
  return { filePath, childDir };
}

export function getPackageType(cwd = process.cwd()): "module" | "commonjs" {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return pkg.type === "module" ? "module" : "commonjs";
  } catch {
    return "commonjs"; // Node default
  }
}

/**
 * Reads a `version` field from this package's own package.json. Used by the
 * CLI to keep `--version` in lockstep with the published version.
 *
 * Falls back to `"0.0.0"` if the file can't be located (e.g. when running
 * from an unusual layout).
 */
export function getOwnPackageVersion(currentFile: string): string {
  // Walk up from the calling file looking for the nearest package.json.
  let dir = path.dirname(currentFile);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === "notion-content-gen" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      /* try parent */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
