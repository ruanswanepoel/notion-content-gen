import fs from "fs";
import path from "path";
import { getProperty, type PageNode } from "../page_node.js";
import type { Plugin } from "../types.js";
import { frontmatterPlugin } from "../plugins/frontmatter.js";
import {
  mdxBlocksPlugin,
  type MdxBlocksPluginOptions,
} from "../plugins/mdx_blocks.js";

export type FumadocsPresetOptions = {
  /**
   * Notion checkbox property used to filter draft pages. When the property
   * exists and is `false`, the page (and its descendants) are skipped. When
   * the property is missing, the page is kept. Defaults to `"Published"`.
   */
  publishedProperty?: string;
  /**
   * Notion rich_text property used as the `description` frontmatter field.
   * Defaults to `"Description"`.
   */
  descriptionProperty?: string;
  /**
   * Notion checkbox property used as the `full` frontmatter field (Fumadocs
   * full-width page mode). Defaults to `"Full"`.
   */
  fullProperty?: string;
  /**
   * Options forwarded to the underlying MDX-blocks plugin (emoji → callout
   * type mapping, etc.).
   */
  mdxBlocks?: MdxBlocksPluginOptions;
};

/**
 * Bundles the plugins required to produce Fumadocs-compatible output:
 *
 * - YAML frontmatter (`title`, `description`, `icon`, `full`)
 * - `meta.json` per directory, preserving Notion's page order
 * - MDX block transformations (callouts → `<Callout>`, toggles → `<Accordion>`)
 * - Draft filtering via a Notion checkbox property
 *
 * Returns the plugins as an array so callers can spread them alongside their
 * own plugins, or trim/replace pieces as needed. Plugins fire in declaration
 * order — anything spread *before* this preset's plugins runs first.
 */
export function fumadocsPreset(
  options: FumadocsPresetOptions = {},
): Plugin[] {
  const publishedProp = options.publishedProperty ?? "Published";
  const descriptionProp = options.descriptionProperty ?? "Description";
  const fullProp = options.fullProperty ?? "Full";

  const draftFilter: Plugin = {
    name: "fumadocs:drafts",
    hooks: {
      filter: (node) => {
        // Root has no real properties — always keep it.
        if (node.parentNode === null) return true;
        const published = getCheckbox(node, publishedProp);
        // Missing property = treat as published.
        return published === undefined ? true : published;
      },
    },
  };

  const frontmatter = frontmatterPlugin(
    (node) => {
      // The synthetic root node ("Root") has no real Notion page properties
      // and its file is rarely consumed as docs — skip frontmatter on it.
      if (node.parentNode === null) return undefined;
      return {
        title: node.notionTitle,
        description: getRichText(node, descriptionProp),
        icon: getIconString(node),
        full: getCheckbox(node, fullProp),
      };
    },
    { name: "fumadocs:frontmatter" },
  );

  const meta: Plugin = {
    name: "fumadocs:meta",
    hooks: {
      afterAll: (tree, ctx) => {
        // `afterAll` still fires in dry-run so plugins can run validation —
        // skip the actual sidecar writes here, but recurse so a plugin chain
        // remains predictable.
        if (ctx.dryRun) return;
        writeMetaFiles(tree);
      },
    },
  };

  return [draftFilter, mdxBlocksPlugin(options.mdxBlocks), frontmatter, meta];
}

function writeMetaFiles(node: PageNode): void {
  if (!node.childDir) return;
  // Drafts are flagged `filtered` (their MDX is never written) but remain in
  // the tree with a resolved `filePath`. They must not appear in the sidebar,
  // so drop them before deriving slugs and before recursing.
  const publishedChildren = node.childNodes.filter((c) => !c.filtered);
  if (publishedChildren.length === 0) return;
  const pages = publishedChildren
    .map((child) => slugForMeta(child))
    .filter((s): s is string => Boolean(s));
  if (pages.length === 0) return;
  // Fumadocs reads a folder's meta from a file named `meta.json` (basename
  // `meta`); an underscore-prefixed name is collected but never applied.
  const metaPath = path.join(node.childDir, "meta.json");
  if (!fs.existsSync(node.childDir)) {
    fs.mkdirSync(node.childDir, { recursive: true });
  }
  fs.writeFileSync(metaPath, JSON.stringify({ pages }, null, 2));
  for (const child of publishedChildren) {
    writeMetaFiles(child);
  }
}

function slugForMeta(node: PageNode): string | undefined {
  if (!node.filePath) return undefined;
  const ext = path.extname(node.filePath);
  const base = path.basename(node.filePath, ext);
  // Directory pages live at `<slug>/index.<ext>`; sidebar slug is the dir name.
  if (base === "index") return path.basename(path.dirname(node.filePath));
  return base;
}

// --- Notion property extractors -------------------------------------------

function getRichText(node: PageNode, name: string): string | undefined {
  const prop = getProperty(node, name);
  if (!prop || prop.type !== "rich_text") return undefined;
  const text = prop.rich_text.map((r) => r.plain_text).join("");
  return text || undefined;
}

function getCheckbox(node: PageNode, name: string): boolean | undefined {
  const prop = getProperty(node, name);
  if (!prop || prop.type !== "checkbox") return undefined;
  return prop.checkbox;
}

function getIconString(node: PageNode): string | undefined {
  const icon = node.icon;
  if (!icon) return undefined;
  if (icon.type === "emoji") return icon.emoji;
  if (icon.type === "external") return icon.external.url;
  if (icon.type === "file") return icon.file.url;
  return undefined;
}
