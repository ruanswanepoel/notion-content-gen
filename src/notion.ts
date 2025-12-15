// passing notion client to the option
const n2m = new NotionToMarkdown({
  notionClient: notion,
  config: {
    parseChildPages: false,
  },
});

async function retrievePage(pageId: string) {
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
