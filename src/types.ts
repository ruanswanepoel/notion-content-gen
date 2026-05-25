import type {
  BlockObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import type { MdStringObject } from "notion-to-md/build/types/index.js";
import z from "zod";

// Notion types
export type NotionBlock = BlockObjectResponse;
export type NotionPage = PageObjectResponse;

// Actual return type of NotionParser.retrievePage
export type RetrievedPage = {
  blocks: { results: BlockChildrenResponseExtended[] };
  mdString: MdStringObject;
  childPages: BlockChildrenResponseExtended[];
};

// Extended Notion types
/// Represents the metadata in a Notion page
export type NcgNotionMetadata = {
  published?: boolean;
  title?: string;
  description?: string;
  slug?: string;
};
export type NotionPageExtended = NotionPage & {
  ncgMetadata?: NcgNotionMetadata;
  child_page?: NotionPageExtended;
};

export type BlockChildrenResponseExtended = {
  object: string;
  id: string;
  parent: {
    type: string;
    page_id: string;
  };
  created_time: string;
  last_edited_time: string;
  created_by: {
    object: string;
    id: string;
  };
  last_edited_by: {
    object: string;
    id: string;
  };
  has_children: boolean;
  archived: boolean;
  in_trash: boolean;
  type: string;
  child_page: {
    title: string;
  };
};

// Plugin system
import type { PageNode } from "./page_node.js";

export type Plugin = {
  name: string;
  hooks?: {
    filter?: (node: PageNode) => boolean;
    transform?: (content: string, node: PageNode) => string;
    onFileWritten?: (filePath: string, node: PageNode) => void;
  };
};

// External Config
export const ConfigSchema = z.object({
  notionToken: z.string().min(1, "notionToken is required"),
  notionPageId: z.string().min(1, "notionPageId is required"),
  contentDir: z.string().default("content"),
  fileExtension: z.string().default("md"),
});

export type Config = z.infer<typeof ConfigSchema> & {
  plugins?: Plugin[];
};
