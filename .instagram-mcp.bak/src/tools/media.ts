import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

const MEDIA_FIELDS = [
  "id",
  "media_type",
  "media_url",
  "permalink",
  "caption",
  "timestamp",
  "thumbnail_url",
  "like_count",
  "comments_count",
  "is_comment_enabled",
  "owner",
].join(",");

const MediaItem = {
  id: z.string(),
  media_type: z.string().optional(),
  media_url: z.string().optional(),
  permalink: z.string().optional(),
  caption: z.string().optional(),
  timestamp: z.string().optional(),
  thumbnail_url: z.string().optional(),
  like_count: z.number().int().optional(),
  comments_count: z.number().int().optional(),
  is_comment_enabled: z.boolean().optional(),
};

interface RawMedia {
  id: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
  thumbnail_url?: string;
  like_count?: number;
  comments_count?: number;
  is_comment_enabled?: boolean;
}

export const mediaTools: AnyToolDefinition[] = [
  {
    name: "instagram_get_media",
    title: "Get media",
    description:
      "Get full details for one of your posts, including like_count, comments_count, caption, permalink, and timestamp.",
    inputShape: { media_id: z.string() },
    outputShape: MediaItem,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const res = await client.request<RawMedia>(`/${input.media_id}`, {
        query: { fields: MEDIA_FIELDS },
      });
      return {
        id: res.id,
        media_type: res.media_type,
        media_url: res.media_url,
        permalink: res.permalink,
        caption: res.caption,
        timestamp: res.timestamp,
        thumbnail_url: res.thumbnail_url,
        like_count: res.like_count,
        comments_count: res.comments_count,
        is_comment_enabled: res.is_comment_enabled,
      };
    },
  },
  {
    name: "instagram_list_recent_media",
    title: "List recent media",
    description:
      "List the account's recent posts in reverse chronological order. Pass `after_cursor` from a previous response to paginate.",
    inputShape: {
      limit: z.number().int().min(1).max(100).default(25),
      after_cursor: z.string().optional(),
    },
    outputShape: {
      items: z.array(z.object(MediaItem)),
      next_cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const query: Record<string, string | number> = {
        fields: MEDIA_FIELDS,
        limit: input.limit,
      };
      if (input.after_cursor) query.after = input.after_cursor;
      const igUserId = await client.igUserId();
      const { items, nextCursor } = await client.paginate<RawMedia>(
        `/${igUserId}/media`,
        { query, maxItems: input.limit },
      );
      return {
        items: items.map((r) => ({
          id: r.id,
          media_type: r.media_type,
          media_url: r.media_url,
          permalink: r.permalink,
          caption: r.caption,
          timestamp: r.timestamp,
          thumbnail_url: r.thumbnail_url,
          like_count: r.like_count,
          comments_count: r.comments_count,
          is_comment_enabled: r.is_comment_enabled,
        })),
        next_cursor: nextCursor,
      };
    },
  },
  {
    name: "instagram_delete_media",
    title: "Delete media",
    description:
      "Permanently delete one of your posts. This is irreversible. The agent should confirm with the user before calling this.",
    inputShape: { media_id: z.string() },
    outputShape: {
      deleted: z.boolean(),
      media_id: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      await client.request<unknown>(`/${input.media_id}`, { method: "DELETE" });
      return { deleted: true, media_id: input.media_id };
    },
  },
  {
    name: "instagram_toggle_comments",
    title: "Toggle comments on a post",
    description:
      "Enable or disable comments on one of your posts. Set `enabled: false` to disable comments, `enabled: true` to re-enable.",
    inputShape: {
      media_id: z.string(),
      enabled: z.boolean(),
    },
    outputShape: {
      media_id: z.string(),
      comments_enabled: z.boolean(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "commentModeration",
    handler: async (input, client) => {
      await client.request<unknown>(`/${input.media_id}`, {
        method: "POST",
        query: { comment_enabled: input.enabled },
      });
      return { media_id: input.media_id, comments_enabled: input.enabled };
    },
  },
];
