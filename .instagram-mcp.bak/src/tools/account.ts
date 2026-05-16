import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

const WHO_AM_I_FIELDS = [
  "user_id",
  "username",
  "name",
  "account_type",
  "profile_picture_url",
  "followers_count",
  "follows_count",
  "media_count",
  "biography",
  "website",
].join(",");

export const accountTools: AnyToolDefinition[] = [
  {
    name: "instagram_who_am_i",
    title: "Who am I",
    description:
      "Returns the authenticated Instagram Business or Creator Account's profile. Call this once at the start of a session to confirm auth is working and to learn the account's username, type (BUSINESS|MEDIA_CREATOR), follower count, and bio.",
    inputShape: {},
    outputShape: {
      ig_user_id: z.string(),
      username: z.string(),
      name: z.string().optional(),
      account_type: z.string().optional(),
      followers_count: z.number().int().optional(),
      follows_count: z.number().int().optional(),
      media_count: z.number().int().optional(),
      profile_picture_url: z.string().optional(),
      biography: z.string().optional(),
      website: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (_input, client) => {
      const res = await client.request<Record<string, unknown>>("/me", {
        query: { fields: WHO_AM_I_FIELDS },
      });
      const fallbackId = await client.igUserId();
      return {
        ig_user_id: String(res.user_id ?? res.id ?? fallbackId),
        username: String(res.username ?? ""),
        name: res.name as string | undefined,
        account_type: res.account_type as string | undefined,
        followers_count: res.followers_count as number | undefined,
        follows_count: res.follows_count as number | undefined,
        media_count: res.media_count as number | undefined,
        profile_picture_url: res.profile_picture_url as string | undefined,
        biography: res.biography as string | undefined,
        website: res.website as string | undefined,
      };
    },
  },
];
