import z from "zod";

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

// External Config
export const ConfigSchema = z.object({
  notionToken: z.string().min(1, "notionToken is required"),
  notionPageId: z.string().min(1, "notionPageId is required"),
  contentDir: z.string().default("content"),
});

export type Config = z.infer<typeof ConfigSchema>;
