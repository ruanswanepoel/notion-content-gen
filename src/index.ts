import fs from "fs";
import path from "path";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
// import { NotionConverter } from 'notion-to-md'
import "dotenv/config";
import { safeStringify, slugify } from "./util.js";

const NOTION_SECRET = process.env.NOTION_SECRET!;
const ROOT_PAGE_ID = "2bb717f5edb9803ca0ecd7db08815ad2"; //'2b3717f5edb9802b9fd6cae83ae97abc'

// Initializing a client
const notion = new Client({
  auth: NOTION_SECRET,
});

export class NotionContentGen {
  client: Client;

  constructor(client: Client) {
    this.client = client;
  }
}

async function buildPageTree() {
  const rootNode: Node = {
    notionId: ROOT_PAGE_ID,
    notionTitle: "Root",
    notionPage: null,
    parentNode: null,
    childNodes: [],
  };
  let queue = [rootNode];

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!; // Currunt node, never undefined
    const retrievedPage = await retrievePage(node.notionId);
    node.notionPage = {
      ...node.notionPage, // Preserve existing metadata
      ...retrievedPage,
    };

    if (!node.notionPage?.childPages) continue;

    for (let cp of node.notionPage?.childPages) {
      const newNode = {
        notionId: cp.id,
        notionTitle: cp.child_page.title,
        notionPage: {
          metadata: cp,
        },
        parentNode: node,
        childNodes: [],
      };
      node.childNodes.push(newNode);
      queue.push(newNode);
    }
  }

  return rootNode;
}

// function getTreeString(node, depth = 0) {
//   let nodeStr = `${'|  '.repeat(depth)}${node.notionTitle}\n`
//
//   if (node.childNodes?.length) {
//     for (const cn of node.childNodes) {
//       nodeStr += getTreeString(cn, depth + 1)
//     }
//   }
//
//   return nodeStr
// }

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
