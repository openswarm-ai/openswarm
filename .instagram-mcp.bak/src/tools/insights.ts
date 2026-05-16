import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

interface RawMetric {
  name: string;
  period?: string;
  values: Array<{ value: number | Record<string, number>; end_time?: string }>;
  title?: string;
  description?: string;
  total_value?: { value: number };
}

interface InsightsResponse {
  data: RawMetric[];
}

const METRICS_BY_MEDIA_TYPE: Record<string, string[]> = {
  IMAGE: ["reach", "likes", "comments", "shares", "saved", "total_interactions"],
  VIDEO: [
    "reach",
    "likes",
    "comments",
    "shares",
    "saved",
    "total_interactions",
    "views",
  ],
  REELS: [
    "reach",
    "likes",
    "comments",
    "shares",
    "saved",
    "total_interactions",
    "views",
    "ig_reels_avg_watch_time",
    "ig_reels_video_view_total_time",
  ],
  CAROUSEL_ALBUM: [
    "reach",
    "likes",
    "comments",
    "shares",
    "saved",
    "total_interactions",
  ],
  STORY: [
    "views",
    "reach",
    "replies",
    "navigation",
    "exits",
    "profile_activity",
  ],
};

function flattenMetrics(raw: RawMetric[]): Record<string, number | Record<string, number>> {
  const out: Record<string, number | Record<string, number>> = {};
  for (const m of raw) {
    if (m.total_value && typeof m.total_value.value === "number") {
      out[m.name] = m.total_value.value;
    } else if (m.values.length > 0) {
      const first = m.values[0];
      if (first) out[m.name] = first.value;
    }
  }
  return out;
}

export const insightsTools: AnyToolDefinition[] = [
  {
    name: "instagram_get_media_insights",
    title: "Get media insights",
    description:
      "Per-post analytics for one of your posts. Auto-selects the correct metric set for the media type (IMAGE/VIDEO/REELS/CAROUSEL). For Reels you get views, average watch time, and total view time. For all post types you get reach, likes, comments, shares, saved, and total_interactions.",
    inputShape: { media_id: z.string() },
    outputShape: {
      media_id: z.string(),
      media_type: z.string(),
      metrics: z.record(z.unknown()),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      // First fetch the media_type so we request the right metric set.
      const meta = await client.request<{ media_type?: string; media_product_type?: string }>(
        `/${input.media_id}`,
        { query: { fields: "media_type,media_product_type" } },
      );
      const mediaType =
        meta.media_product_type === "REELS"
          ? "REELS"
          : meta.media_type ?? "IMAGE";
      const metrics = METRICS_BY_MEDIA_TYPE[mediaType] ?? METRICS_BY_MEDIA_TYPE.IMAGE!;
      const res = await client.request<InsightsResponse>(`/${input.media_id}/insights`, {
        query: { metric: metrics.join(",") },
      });
      return {
        media_id: input.media_id,
        media_type: mediaType,
        metrics: flattenMetrics(res.data),
      };
    },
  },
  {
    name: "instagram_get_story_insights",
    title: "Get Story insights",
    description:
      "Analytics for a Story post. Story insights expire 24 hours after the story does, so call this within ~24h of publishing. Returns views, reach, replies, navigation, exits, and profile_activity.",
    inputShape: { story_media_id: z.string() },
    outputShape: {
      story_id: z.string(),
      metrics: z.record(z.unknown()),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const res = await client.request<InsightsResponse>(
        `/${input.story_media_id}/insights`,
        { query: { metric: METRICS_BY_MEDIA_TYPE.STORY!.join(",") } },
      );
      return {
        story_id: input.story_media_id,
        metrics: flattenMetrics(res.data),
      };
    },
  },
  {
    name: "instagram_get_account_insights",
    title: "Get account insights",
    description:
      "Account-level analytics over a date range (max 30 days). Default metrics include reach, profile_views, accounts_engaged, total_interactions, follows_and_unfollows, website_clicks, and profile_links_taps. Pass `metrics` to override.",
    inputShape: {
      since: z.string().describe("Start date (YYYY-MM-DD or unix epoch seconds)."),
      until: z.string().describe("End date, ≤30 days after `since`."),
      metrics: z
        .array(z.string())
        .optional()
        .describe("Override default metric set."),
    },
    outputShape: {
      since: z.string(),
      until: z.string(),
      metrics: z.record(z.unknown()),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const metrics =
        input.metrics ??
        [
          "reach",
          "profile_views",
          "accounts_engaged",
          "total_interactions",
          "follows_and_unfollows",
          "website_clicks",
          "profile_links_taps",
        ];
      const igUserId = await client.igUserId();
      const res = await client.request<InsightsResponse>(
        `/${igUserId}/insights`,
        {
          query: {
            metric: metrics.join(","),
            period: "day",
            metric_type: "total",
            since: input.since,
            until: input.until,
          },
        },
      );
      return {
        since: input.since,
        until: input.until,
        metrics: flattenMetrics(res.data),
      };
    },
  },
  {
    name: "instagram_get_audience_insights",
    title: "Get audience demographics",
    description:
      "Audience demographic breakdowns (city, country, age, gender, age_gender). Requires the account to have at least 100 followers. Returns a mapping from breakdown value to follower count.",
    inputShape: {
      breakdown: z.enum(["city", "country", "age", "gender", "age_gender"]),
      timeframe: z
        .enum(["this_week", "this_month", "prev_month"])
        .default("this_month"),
    },
    outputShape: {
      breakdown: z.string(),
      timeframe: z.string(),
      values: z.record(z.number()),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const igUserId = await client.igUserId();
      const res = await client.request<InsightsResponse>(
        `/${igUserId}/insights`,
        {
          query: {
            metric: "follower_demographics",
            period: "lifetime",
            timeframe: input.timeframe,
            breakdown: input.breakdown,
            metric_type: "total",
          },
        },
      );
      const values: Record<string, number> = {};
      for (const m of res.data) {
        const v = m.values[0]?.value;
        if (typeof v === "object" && v !== null) {
          for (const [k, count] of Object.entries(v as Record<string, number>)) {
            values[k] = count;
          }
        }
      }
      return {
        breakdown: input.breakdown,
        timeframe: input.timeframe,
        values,
      };
    },
  },
];
