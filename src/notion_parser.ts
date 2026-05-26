import {
  Client,
  isFullBlock,
  isFullPage,
  type BlockObjectResponse,
  type ChildPageBlockObjectResponse,
  type ListBlockChildrenResponse,
} from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { RetrievedPage } from "./types.js";
import type { ListBlockChildrenResponseResults } from "notion-to-md/build/types/index.js";
import { withRetry } from "./retry.js";

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
   *
   * Block children are fully paginated — pages with more than 100 blocks are
   * fetched in their entirety.
   */
  async retrievePage(
    pageId: string,
    options: RetrievePageOptions = {},
  ): Promise<RetrievedPage> {
    const [pageResult, blocks] = await Promise.all([
      withRetry(() => this.notionClient.pages.retrieve({ page_id: pageId })),
      this.listAllBlockChildren(pageId),
    ]);

    if (!isFullPage(pageResult)) {
      throw new Error(
        `Notion returned a partial page object for ${pageId}. Check that the integration has access to this page.`,
      );
    }

    const childPages = blocks.filter(
      (b): b is ChildPageBlockObjectResponse => b.type === "child_page",
    );

    const mdString = options.skipMarkdown
      ? ""
      : await this.convertBlocksToMarkdown(blocks);

    return {
      page: pageResult,
      blocks,
      mdString,
      childPages,
    };
  }

  /**
   * Iterates through every page of `blocks.children.list` for the given block
   * and returns the full concatenated list. Notion paginates at 100 entries
   * per response, so this is required for any page with more than 100 blocks
   * or 100 children.
   *
   * Partial-block results from the SDK are filtered out — the rest of the
   * pipeline only handles full blocks.
   */
  async listAllBlockChildren(
    blockId: string,
  ): Promise<BlockObjectResponse[]> {
    const all: BlockObjectResponse[] = [];
    let cursor: string | undefined = undefined;
    do {
      const params: { block_id: string; start_cursor?: string } = {
        block_id: blockId,
      };
      if (cursor) params.start_cursor = cursor;
      const response: ListBlockChildrenResponse = await withRetry(() =>
        this.notionClient.blocks.children.list(params),
      );
      for (const block of response.results) {
        if (isFullBlock(block)) all.push(block);
      }
      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);
    return all;
  }

  /**
   * Converts a list of Notion blocks into a markdown string. Exposed so callers
   * that initially skipped markdown (e.g. incremental sync) can convert later.
   */
  async convertBlocksToMarkdown(
    blocks: BlockObjectResponse[],
  ): Promise<string> {
    const mdBlocks = await this.n2m.blocksToMarkdown(
      blocks as unknown as ListBlockChildrenResponseResults,
    );
    const md = this.n2m.toMarkdownString(mdBlocks);
    return md.parent ?? "";
  }
}
