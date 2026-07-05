import type { PageNode } from "../page_node.js";
import type { Plugin } from "../types.js";

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FrontmatterValue[];

export type FrontmatterData = Record<string, FrontmatterValue>;

export type FrontmatterExtractor = (
  node: PageNode,
) => FrontmatterData | undefined | null | Promise<FrontmatterData | undefined | null>;

export type FrontmatterPluginOptions = {
  /** Override the plugin name (used in stack traces and logging). */
  name?: string;
};

/**
 * Generic YAML-frontmatter plugin: extracts a data object from each node and
 * prepends it as a YAML frontmatter block. The shape of the data is fully
 * controlled by the caller — there are no built-in property names.
 *
 * Keys whose value resolves to `undefined` or `null` are omitted from the
 * output so callers can return partial data without producing empty fields.
 *
 * Returns `undefined` from the extractor to skip the node entirely (no
 * frontmatter prepended).
 */
export function frontmatterPlugin(
  extract: FrontmatterExtractor,
  options: FrontmatterPluginOptions = {},
): Plugin {
  return {
    name: options.name ?? "frontmatter",
    hooks: {
      transform: async (content, node) => {
        const data = await extract(node);
        if (!data) return content;
        const block = toYamlFrontmatter(data);
        if (!block) return content;
        return `${block}\n${content}`;
      },
    },
  };
}

/**
 * Serializes a flat object of scalars (and arrays of scalars) to a YAML
 * frontmatter block (`---\n...\n---`). Returns an empty string if no keys
 * have meaningful values.
 */
export function toYamlFrontmatter(data: FrontmatterData): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  if (lines.length === 0) return "";
  return `---\n${lines.join("\n")}\n---`;
}

function formatYamlValue(value: FrontmatterValue): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((v) => v !== undefined && v !== null)
      .map((v) => formatYamlValue(v));
    return `[${items.join(", ")}]`;
  }
  return formatYamlString(String(value));
}

const YAML_NEEDS_QUOTE = /[:#&*?|>'"%@`!,\[\]{}\n\r\t]/;

function formatYamlString(s: string): string {
  if (s === "") return '""';
  if (
    YAML_NEEDS_QUOTE.test(s) ||
    /^[ \t]/.test(s) ||
    /[ \t]$/.test(s) ||
    /^(?:true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^-?\d+(?:\.\d+)?$/.test(s)
  ) {
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return s;
}
