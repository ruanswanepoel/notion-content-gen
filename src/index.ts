const ROOT_PAGE_ID = "2bb717f5edb9803ca0ecd7db08815ad2"; //'2b3717f5edb9802b9fd6cae83ae97abc'

export class NotionContentGen {
  client: Client;

  constructor(client: Client) {
    this.client = client;
  }
}

(async () => {
  // const blocks = await notion.blocks.children.list({
  //   block_id: ROOT_PAGE_ID,
  // })
  // console.log(JSON.stringify(blocks, '', 4))
  //
  const pageTree = await buildPageTree();
  //
  writeMarkdownPageTree(pageTree, "mycontent");
  //
  // console.log('------------------')
  // console.log(safeStringify(pageTree))
  // console.log('--------------------- end')
  // const str = getTreeString(pageTree)
  // console.log(str)
})();
