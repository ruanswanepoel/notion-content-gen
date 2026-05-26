import { Client, isFullPage } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { BlockChildrenResponseExtended, RetrievedPage } from "./types.js";
import type {
  ListBlockChildrenResponseResults,
  MdStringObject,
} from "notion-to-md/build/types/index.js";
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
    const [pageResult, blockResults] = await Promise.all([
      withRetry(() => this.notionClient.pages.retrieve({ page_id: pageId })),
      this.listAllBlockChildren(pageId),
    ]);

    if (!isFullPage(pageResult)) {
      throw new Error(
        `Notion returned a partial page object for ${pageId}. Check that the integration has access to this page.`,
      );
    }

    const childPages = blockResults.filter(
      (page) => page.type == "child_page",
    );

    const mdString: MdStringObject = options.skipMarkdown
      ? { parent: "" }
      : await this.convertBlocksToMarkdown(blockResults);

    return {
      page: pageResult,
      blocks: { results: blockResults },
      mdString,
      childPages,
    };
  }

  /**
   * Iterates through every page of `blocks.children.list` for the given block
   * and returns the full concatenated list. Notion paginates at 100 entries
   * per response, so this is required for any page with more than 100 blocks
   * or 100 children.
   */
  async listAllBlockChildren(
    blockId: string,
  ): Promise<BlockChildrenResponseExtended[]> {
    const all: BlockChildrenResponseExtended[] = [];
    let cursor: string | undefined = undefined;
    do {
      const params: { block_id: string; start_cursor?: string } = {
        block_id: blockId,
      };
      if (cursor) params.start_cursor = cursor;
      const response = (await withRetry(() =>
        this.notionClient.blocks.children.list(params),
      )) as unknown as {
        results: BlockChildrenResponseExtended[];
        has_more: boolean;
        next_cursor: string | null;
      };
      all.push(...response.results);
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return all;
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
