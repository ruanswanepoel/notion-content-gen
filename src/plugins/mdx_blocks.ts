import type {
  CalloutBlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client";
import type { Plugin } from "../types.js";

export type CalloutType = "info" | "warn" | "error";

export type MdxBlocksPluginOptions = {
  /**
   * Override the emoji → callout type mapping. Anything not listed falls back
   * to `info`.
   */
  calloutTypeByEmoji?: Record<string, CalloutType>;
  /**
   * Override the plugin name (used in stack traces and logging).
   */
  name?: string;
};

const DEFAULT_CALLOUT_MAP: Record<string, CalloutType> = {
  "⚠️": "warn",
  "⚠": "warn",
  "🚧": "warn",
  "🟡": "warn",
  "❌": "error",
  "🚫": "error",
  "🛑": "error",
  "🔴": "error",
  "💡": "info",
  "ℹ️": "info",
  "ℹ": "info",
  "📘": "info",
};

/**
 * Maps Notion blocks to Fumadocs / MDX components.
 *
 * - Callouts are fully rewritten via a `notion-to-md` custom transformer.
 * - Toggles are rewritten via a `transform` post-process step (n2m's default
 *   `<details><summary>...</summary>...</details>` output is detected and
 *   wrapped in `<Accordions><Accordion title="...">...</Accordion></Accordions>`).
 * - Columns are *not* transformed: `notion-to-md` discards the column
 *   container blocks before reaching markdown, so the structure isn't
 *   recoverable post-conversion. Authors who need columns should reach for a
 *   different block type until upstream exposes them.
 */
export function mdxBlocksPlugin(
  options: MdxBlocksPluginOptions = {},
): Plugin {
  const calloutMap = { ...DEFAULT_CALLOUT_MAP, ...options.calloutTypeByEmoji };

  return {
    name: options.name ?? "mdx-blocks",
    hooks: {
      setup: ({ notion }) => {
        notion.n2m.setCustomTransformer("callout", async (block) => {
          const callout = block as CalloutBlockObjectResponse;
          if (callout.type !== "callout") return false;
          const text = richTextToPlain(callout.callout.rich_text);
          const type = resolveCalloutType(callout, calloutMap);
          return `<Callout type="${type}">\n${text}\n</Callout>`;
        });
      },
      transform: (content) => rewriteDetails(content),
    },
  };
}

function resolveCalloutType(
  callout: CalloutBlockObjectResponse,
  map: Record<string, CalloutType>,
): CalloutType {
  const icon = callout.callout.icon;
  if (icon?.type === "emoji" && map[icon.emoji]) {
    return map[icon.emoji]!;
  }
  return "info";
}

function richTextToPlain(rich: RichTextItemResponse[]): string {
  return rich.map((r) => r.plain_text).join("");
}

const DETAILS_RE =
  /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;

function rewriteDetails(content: string): string {
  let out = content.replace(DETAILS_RE, (_match, summary: string, body: string) => {
    const title = escapeAttribute(summary.trim());
    return `<Accordions>\n<Accordion title="${title}">\n${body.trim()}\n</Accordion>\n</Accordions>`;
  });

  // Collapse adjacent <Accordions> blocks so consecutive Notion toggles render
  // as siblings inside a single Accordions container.
  out = out.replace(
    /<\/Accordions>\n+<Accordions>\n/g,
    "",
  );

  return out;
}

function escapeAttribute(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
