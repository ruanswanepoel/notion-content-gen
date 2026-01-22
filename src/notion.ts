import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import "dotenv/config";
import type { BlockChildrenResponseExtended } from "./types.js";
import type { ListBlockChildrenResponseResults } from "notion-to-md/build/types/index.js";

// TODO: Use config
const NOTION_SECRET = process.env.NOTION_SECRET!;

const notion = new Client({
  auth: NOTION_SECRET,
});

const n2m = new NotionToMarkdown({
  notionClient: notion,
  config: {
    parseChildPages: false,
  },
});

/**
 * Retrieves a single Notion page and conveniently converts the content to markdown and finds the child pages.
 */
export async function retrievePage(pageId: string) {
  const blocks = (await notion.blocks.children.list({
    block_id: pageId,
  })) as unknown as { results: BlockChildrenResponseExtended[] };

  const childPages = blocks.results.filter((page) => page.type == "child_page");

  // Convert to markdown
  const mdBlocks = await n2m.blocksToMarkdown(
    blocks.results as ListBlockChildrenResponseResults,
  );
  const mdString = n2m.toMarkdownString(mdBlocks);

  return {
    blocks,
    mdString,
    childPages,
  };
}
