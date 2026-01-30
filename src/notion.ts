import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { BlockChildrenResponseExtended } from "./types.js";
import type { ListBlockChildrenResponseResults } from "notion-to-md/build/types/index.js";

export class Notion {
  notionClient: Client;
  n2m: NotionToMarkdown;

  constructor(notion_secret: string) {
    this.notionClient = new Client({
      auth: notion_secret,
    });

    this.n2m = new NotionToMarkdown({
      notionClient: this.notionClient,
      config: {
        parseChildPages: false,
      },
    });
  }

  /**
   * Retrieves a single Notion page and conveniently converts the content to markdown and finds the child pages.
   */
  async retrievePage(pageId: string) {
    const blocks = (await this.notionClient.blocks.children.list({
      block_id: pageId,
    })) as unknown as { results: BlockChildrenResponseExtended[] };

    const childPages = blocks.results.filter(
      (page) => page.type == "child_page",
    );

    // Convert to markdown
    const mdBlocks = await this.n2m.blocksToMarkdown(
      blocks.results as ListBlockChildrenResponseResults,
    );
    const mdString = this.n2m.toMarkdownString(mdBlocks);

    return {
      blocks,
      mdString,
      childPages,
    };
  }
}
