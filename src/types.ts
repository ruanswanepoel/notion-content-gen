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
  page: PageObjectResponse;
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

/**
 * onError handlers return `true` to suppress the error and continue. Any other
 * return value (including a thrown error) causes the error to propagate.
 *
 * - During tree build: a suppressed error drops the failing node (and any of
 *   its undiscovered children) from the tree.
 * - During generation: a suppressed error skips the failing node's file write
 *   but still recurses into its children.
 */
export type Plugin = {
  name: string;
  hooks?: {
    /** Fires once before generation starts, after the page tree is built. */
    beforeAll?: (tree: PageNode) => void | Promise<void>;
    /** Fires once after all files have been written. */
    afterAll?: (tree: PageNode) => void | Promise<void>;
    /** Return `false` to skip the node and its descendants. */
    filter?: (node: PageNode) => boolean | Promise<boolean>;
    /** Receive the markdown string for a node and return a (possibly modified) replacement. */
    transform?: (content: string, node: PageNode) => string | Promise<string>;
    /** Fires after a file is written for a node. */
    onFileWritten?: (filePath: string, node: PageNode) => void | Promise<void>;
    /** Fires when a per-node error occurs. Return `true` to suppress. */
    onError?: (
      err: unknown,
      node: PageNode,
    ) => boolean | void | Promise<boolean | void>;
  };
};

// External Config
export const ConfigSchema = z.object({
  notionToken: z.string().min(1, "notionToken is required"),
  notionPageId: z.string().min(1, "notionPageId is required"),
  contentDir: z.string().default("content"),
  fileExtension: z.string().default("md"),
  cache: z.union([z.boolean(), z.string()]).default(true),
});

export type Config = z.infer<typeof ConfigSchema> & {
  plugins?: Plugin[];
};
