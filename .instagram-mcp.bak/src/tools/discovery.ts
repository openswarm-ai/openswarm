import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

interface DiscoveryMedia {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
  timestamp?: string;
}

interface DiscoveryResponse {
  business_discovery?: {
    id?: string;
    username?: string;
    name?: string;
    biography?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
    profile_picture_url?: string;
    website?: string;
    media?: { data?: DiscoveryMedia[] };
  };
}

export const discoveryTools: AnyToolDefinition[] = [
  {
    name: "instagram_business_discovery",
    title: "Look up a public Business/Creator account",
    description:
      "Read-only lookup of a public Business or Creator account by username. Use for competitor research, partner vetting, or audience analysis. Personal accounts are NOT accessible via this endpoint. Set include_media=true to also fetch the account's most recent posts (limited by media_limit).",
    inputShape: {
      username: z
        .string()
        .min(1)
        .describe("The target account's Instagram username, without leading @."),
      include_media: z.boolean().default(false),
      media_limit: z.number().int().min(1).max(50).default(10),
    },
    outputShape: {
      username: z.string(),
      name: z.string().optional(),
      biography: z.string().optional(),
      followers_count: z.number().int().optional(),
      follows_count: z.number().int().optional(),
      media_count: z.number().int().optional(),
      profile_picture_url: z.string().optional(),
      website: z.string().optional(),
      media: z
        .array(
          z.object({
            id: z.string(),
            caption: z.string().optional(),
            media_type: z.string().optional(),
            permalink: z.string().optional(),
            like_count: z.number().int().optional(),
            comments_count: z.number().int().optional(),
            timestamp: z.string().optional(),
          }),
        )
        .optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const cleaned = input.username.replace(/^@/, "");
      const accountFields = [
        "id",
        "username",
        "name",
        "biography",
        "followers_count",
        "follows_count",
        "media_count",
        "profile_picture_url",
        "website",
      ];
      let fields = `business_discovery.username(${cleaned}){${accountFields.join(",")}`;
      if (input.include_media) {
        const mediaFields = [
          "id",
          "caption",
          "media_type",
          "permalink",
          "like_count",
          "comments_count",
          "timestamp",
        ].join(",");
        fields += `,media.limit(${input.media_limit}){${mediaFields}}`;
      }
      fields += "}";
      const igUserId = await client.igUserId();
      const res = await client.request<DiscoveryResponse>(`/${igUserId}`, {
        query: { fields },
      });
      const bd = res.business_discovery;
      if (!bd) {
        throw new Error(
          `No public Business/Creator account found for username "${cleaned}". The account may be personal, private, or non-existent.`,
        );
      }
      return {
        username: bd.username ?? cleaned,
        name: bd.name,
        biography: bd.biography,
        followers_count: bd.followers_count,
        follows_count: bd.follows_count,
        media_count: bd.media_count,
        profile_picture_url: bd.profile_picture_url,
        website: bd.website,
        media: bd.media?.data,
      };
    },
  },
];
