import {
  APIErrorCode,
  APIResponseError,
  Client,
  isFullBlock,
  isFullDatabase,
  isFullPage,
  type BlockObjectResponse,
  type ChildDatabaseBlockObjectResponse,
  type ChildPageBlockObjectResponse,
  type DatabaseObjectResponse,
  type ListBlockChildrenResponse,
  type PageObjectResponse,
  type QueryDataSourceResponse,
} from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { NodeKind, RetrievedDatabase, RetrievedPage } from "./types.js";
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
    const childDatabases = blocks.filter(
      (b): b is ChildDatabaseBlockObjectResponse => b.type === "child_database",
    );

    const mdString = options.skipMarkdown
      ? ""
      : await this.convertBlocksToMarkdown(blocks);

    return {
      page: pageResult,
      blocks,
      mdString,
      childPages,
      childDatabases,
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

  /**
   * Probes the Notion API to determine whether an id refers to a page or a
   * database (wiki). Tries the pages endpoint first since regular pages are
   * the more common case at the root level. On a wrong-object-type error,
   * falls back to the databases endpoint.
   *
   * Throws for unrelated errors (auth, network, missing-id), which should
   * propagate so the caller sees the real problem.
   */
  async classifyNode(id: string): Promise<NodeKind> {
    try {
      await withRetry(() => this.notionClient.pages.retrieve({ page_id: id }));
      return "page";
    } catch (err) {
      if (!isWrongObjectTypeError(err)) throw err;
      // If pages.retrieve says "no such page" or "validation error", try the
      // database endpoint. A real not-found will still throw from databases.
      await withRetry(() =>
        this.notionClient.databases.retrieve({ database_id: id }),
      );
      return "wiki";
    }
  }

  /**
   * Retrieves a Notion database (wiki) and queries every item in each of its
   * data sources. Pagination is exhausted internally. The returned `items`
   * list is flat — the tree builder reconstructs hierarchy from each page's
   * `parent` field.
   *
   * Most wikis have a single data source; if Notion ever returns multiple,
   * items from all of them are concatenated in declaration order.
   */
  async retrieveDatabase(databaseId: string): Promise<RetrievedDatabase> {
    const dbResult = await withRetry(() =>
      this.notionClient.databases.retrieve({ database_id: databaseId }),
    );
    if (!isFullDatabase(dbResult)) {
      throw new Error(
        `Notion returned a partial database object for ${databaseId}. Check that the integration has access to this database.`,
      );
    }
    const items: PageObjectResponse[] = [];
    for (const ds of dbResult.data_sources) {
      const dsItems = await this.queryAllDataSourceItems(ds.id);
      items.push(...dsItems);
    }
    return { database: dbResult, items };
  }

  /**
   * Walks every cursor page of `dataSources.query` and returns the
   * concatenated list of full page objects. Partial pages and data-source
   * results are filtered out — the rest of the pipeline only handles full
   * pages.
   */
  async queryAllDataSourceItems(
    dataSourceId: string,
  ): Promise<PageObjectResponse[]> {
    const all: PageObjectResponse[] = [];
    let cursor: string | undefined = undefined;
    do {
      const params: {
        data_source_id: string;
        start_cursor?: string;
      } = { data_source_id: dataSourceId };
      if (cursor) params.start_cursor = cursor;
      const response: QueryDataSourceResponse = await withRetry(() =>
        this.notionClient.dataSources.query(params),
      );
      for (const result of response.results) {
        if (result.object === "page" && isFullPage(result)) {
          all.push(result);
        }
      }
      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);
    return all;
  }
}

/**
 * Returns true when a Notion error indicates "this id exists but isn't the
 * object type we asked for." Used by {@link NotionParser.classifyNode} to
 * decide whether to fall back to the other endpoint.
 *
 * Notion has historically returned either `object_not_found` (the id exists
 * but as a different object type the integration can't access) or
 * `validation_error` (the id format works for a different object type) in
 * this scenario, so we accept both.
 */
function isWrongObjectTypeError(err: unknown): boolean {
  if (!(err instanceof APIResponseError)) return false;
  return (
    err.code === APIErrorCode.ObjectNotFound ||
    err.code === APIErrorCode.ValidationError
  );
}
