import { Client, isFullPage } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { BlockChildrenResponseExtended, RetrievedPage } from "./types.js";
import type { ListBlockChildrenResponseResults } from "notion-to-md/build/types/index.js";

export class NotionParser {
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
  async retrievePage(pageId: string): Promise<RetrievedPage> {
    const [pageResult, blocks] = await Promise.all([
      this.notionClient.pages.retrieve({ page_id: pageId }),
      this.notionClient.blocks.children.list({
        block_id: pageId,
      }) as unknown as Promise<{ results: BlockChildrenResponseExtended[] }>,
    ]);

    if (!isFullPage(pageResult)) {
      throw new Error(
        `Notion returned a partial page object for ${pageId}. Check that the integration has access to this page.`,
      );
    }

    const childPages = blocks.results.filter(
      (page) => page.type == "child_page",
    );

    // Convert to markdown
    const mdBlocks = await this.n2m.blocksToMarkdown(
      blocks.results as ListBlockChildrenResponseResults,
    );
    const mdString = this.n2m.toMarkdownString(mdBlocks);

    return {
      page: pageResult,
      blocks,
      mdString,
      childPages,
    };
  }

}
