import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

const HASHTAG_MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_url",
  "permalink",
  "like_count",
  "comments_count",
  "timestamp",
].join(",");

interface RawHashtagMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
  timestamp?: string;
}

const HashtagMediaItem = {
  id: z.string(),
  caption: z.string().optional(),
  media_type: z.string().optional(),
  media_url: z.string().optional(),
  permalink: z.string().optional(),
  like_count: z.number().int().optional(),
  comments_count: z.number().int().optional(),
  timestamp: z.string().optional(),
};

export const hashtagTools: AnyToolDefinition[] = [
  {
    name: "instagram_search_hashtag",
    title: "Search hashtag",
    description:
      "Resolve a hashtag name to its Graph API id, which other hashtag tools require. NOTE: counts toward Meta's limit of 30 unique hashtag searches per 7-day rolling window per account. Cache the returned id if you'll use it again.",
    inputShape: { name: z.string().min(1).max(100) },
    outputShape: { id: z.string(), name: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const cleaned = input.name.replace(/^#/, "");
      const igUserId = await client.igUserId();
      const res = await client.request<{ data: Array<{ id: string }> }>(
        `/ig_hashtag_search`,
        { query: { user_id: igUserId, q: cleaned } },
      );
      const first = res.data?.[0];
      if (!first) {
        throw new Error(`Hashtag not found: ${cleaned}`);
      }
      return { id: first.id, name: cleaned };
    },
  },
  {
    name: "instagram_get_hashtag_top_media",
    title: "Top media for hashtag",
    description:
      "Highest-performing public posts for a hashtag, ranked by Instagram. Note: hashtag results only include public Business/Creator account posts.",
    inputShape: {
      hashtag_id: z.string(),
      limit: z.number().int().min(1).max(50).default(25),
    },
    outputShape: { items: z.array(z.object(HashtagMediaItem)) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const igUserId = await client.igUserId();
      const res = await client.request<{ data: RawHashtagMedia[] }>(
        `/${input.hashtag_id}/top_media`,
        {
          query: {
            user_id: igUserId,
            fields: HASHTAG_MEDIA_FIELDS,
            limit: input.limit,
          },
        },
      );
      return { items: res.data ?? [] };
    },
  },
  {
    name: "instagram_get_hashtag_recent_media",
    title: "Recent media for hashtag",
    description:
      "Most recent public posts (last 24 hours) tagged with the hashtag. Only public Business/Creator account posts are returned.",
    inputShape: {
      hashtag_id: z.string(),
      limit: z.number().int().min(1).max(50).default(25),
    },
    outputShape: { items: z.array(z.object(HashtagMediaItem)) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const igUserId = await client.igUserId();
      const res = await client.request<{ data: RawHashtagMedia[] }>(
        `/${input.hashtag_id}/recent_media`,
        {
          query: {
            user_id: igUserId,
            fields: HASHTAG_MEDIA_FIELDS,
            limit: input.limit,
          },
        },
      );
      return { items: res.data ?? [] };
    },
  },
];
