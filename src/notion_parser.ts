import { Client, isFullPage } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { BlockChildrenResponseExtended, RetrievedPage } from "./types.js";
import type {
  ListBlockChildrenResponseResults,
  MdStringObject,
} from "notion-to-md/build/types/index.js";

export type RetrievePageOptions = {
  /** When true, skips the markdown conversion step. Useful for incremental sync. */
  skipMarkdown?: boolean;
};

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
   *
   * Pass `{ skipMarkdown: true }` to skip the conversion step — the returned
   * `mdString` will be empty. Use {@link convertBlocksToMarkdown} to convert
   * later if needed.
   */
  async retrievePage(
    pageId: string,
    options: RetrievePageOptions = {},
  ): Promise<RetrievedPage> {
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

    const mdString: MdStringObject = options.skipMarkdown
      ? { parent: "" }
      : await this.convertBlocksToMarkdown(blocks.results);

    return {
      page: pageResult,
      blocks,
      mdString,
      childPages,
    };
  }

  /**
   * Converts a list of Notion blocks into a markdown string. Exposed so callers
   * that initially skipped markdown (e.g. incremental sync) can convert later.
   */
  async convertBlocksToMarkdown(
    blocks: BlockChildrenResponseExtended[],
  ): Promise<MdStringObject> {
    const mdBlocks = await this.n2m.blocksToMarkdown(
      blocks as unknown as ListBlockChildrenResponseResults,
    );
    return this.n2m.toMarkdownString(mdBlocks);
  }
}
