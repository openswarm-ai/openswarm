import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

const COMMENT_FIELDS = ["id", "text", "username", "timestamp", "like_count", "hidden"].join(
  ",",
);

interface RawComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  hidden?: boolean;
}

const CommentItem = {
  id: z.string(),
  text: z.string().optional(),
  username: z.string().optional(),
  timestamp: z.string().optional(),
  like_count: z.number().int().optional(),
  hidden: z.boolean().optional(),
};

export const commentTools: AnyToolDefinition[] = [
  {
    name: "instagram_list_comments",
    title: "List comments on a post",
    description:
      "Paginated list of top-level comments on one of your posts. Use the returned `next_cursor` to fetch more.",
    inputShape: {
      media_id: z.string(),
      limit: z.number().int().min(1).max(50).default(25),
      after_cursor: z.string().optional(),
    },
    outputShape: {
      items: z.array(z.object(CommentItem)),
      next_cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const query: Record<string, string | number> = {
        fields: COMMENT_FIELDS,
        limit: input.limit,
      };
      if (input.after_cursor) query.after = input.after_cursor;
      const { items, nextCursor } = await client.paginate<RawComment>(
        `/${input.media_id}/comments`,
        { query, maxItems: input.limit },
      );
      return { items, next_cursor: nextCursor };
    },
  },
  {
    name: "instagram_list_comment_replies",
    title: "List replies to a comment",
    description: "List the replies (child comments) on a parent comment.",
    inputShape: {
      comment_id: z.string(),
      limit: z.number().int().min(1).max(50).default(25),
      after_cursor: z.string().optional(),
    },
    outputShape: {
      items: z.array(z.object(CommentItem)),
      next_cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const query: Record<string, string | number> = {
        fields: COMMENT_FIELDS,
        limit: input.limit,
      };
      if (input.after_cursor) query.after = input.after_cursor;
      const { items, nextCursor } = await client.paginate<RawComment>(
        `/${input.comment_id}/replies`,
        { query, maxItems: input.limit },
      );
      return { items, next_cursor: nextCursor };
    },
  },
  {
    name: "instagram_reply_to_comment",
    title: "Reply to a comment",
    description: "Post a reply on a comment. The message can include @mentions and emoji.",
    inputShape: {
      comment_id: z.string(),
      message: z.string().min(1).max(2200),
    },
    outputShape: {
      reply_id: z.string(),
      created_at: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "commentModeration",
    handler: async (input, client) => {
      const res = await client.request<{ id: string }>(
        `/${input.comment_id}/replies`,
        { method: "POST", query: { message: input.message } },
      );
      return { reply_id: res.id, created_at: new Date().toISOString() };
    },
  },
  {
    name: "instagram_delete_comment",
    title: "Delete a comment",
    description:
      "Delete a comment. You can delete any comment on your own media, or any comment you authored.",
    inputShape: { comment_id: z.string() },
    outputShape: { deleted: z.boolean(), comment_id: z.string() },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "commentModeration",
    handler: async (input, client) => {
      await client.request<unknown>(`/${input.comment_id}`, { method: "DELETE" });
      return { deleted: true, comment_id: input.comment_id };
    },
  },
  {
    name: "instagram_hide_comment",
    title: "Hide or unhide a comment",
    description:
      "Hide a comment (makes it invisible to other viewers but keeps the comment) or unhide it.",
    inputShape: {
      comment_id: z.string(),
      hidden: z.boolean(),
    },
    outputShape: {
      comment_id: z.string(),
      hidden: z.boolean(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "commentModeration",
    handler: async (input, client) => {
      await client.request<unknown>(`/${input.comment_id}`, {
        method: "POST",
        query: { hide: input.hidden },
      });
      return { comment_id: input.comment_id, hidden: input.hidden };
    },
  },
];
