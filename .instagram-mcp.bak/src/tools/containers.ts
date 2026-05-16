import { z } from "zod";
import { fetchContainerStatus } from "../containers.js";
import type { AnyToolDefinition } from "../tool-registry.js";

const ContainerStatus = z.enum([
  "IN_PROGRESS",
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "PUBLISHED",
]);

export const containerTools: AnyToolDefinition[] = [
  {
    name: "instagram_create_container",
    title: "Create media container (low-level)",
    description:
      "Create a media container without publishing it. Useful for scheduling workflows: create the container now, then call instagram_publish_container at the target time. Containers expire 24 hours after creation. For most use cases prefer the higher-level instagram_publish_image / publish_carousel / publish_reel tools.",
    inputShape: {
      media_type: z
        .enum(["IMAGE", "VIDEO", "REELS", "STORIES", "CAROUSEL"])
        .describe("Container kind."),
      image_url: z.string().url().optional(),
      video_url: z.string().url().optional(),
      caption: z.string().max(2200).optional(),
      children: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Child container ids for CAROUSEL only."),
      is_carousel_item: z.boolean().optional(),
      share_to_feed: z.boolean().optional(),
      cover_url: z.string().url().optional(),
      thumb_offset: z.number().int().nonnegative().optional(),
    },
    outputShape: {
      container_id: z.string(),
      expires_at: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const query: Record<string, string | number | boolean | undefined> = {
        media_type: input.media_type,
        image_url: input.image_url,
        video_url: input.video_url,
        caption: input.caption,
        is_carousel_item: input.is_carousel_item,
        share_to_feed: input.share_to_feed,
        cover_url: input.cover_url,
        thumb_offset: input.thumb_offset,
        children: input.children?.join(","),
      };
      const igUserId = await client.igUserId();
      const res = await client.request<{ id: string }>(`/${igUserId}/media`, {
        method: "POST",
        query,
      });
      return {
        container_id: res.id,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    },
  },
  {
    name: "instagram_get_container_status",
    title: "Get media container status",
    description:
      "Check the processing status of a media container. Returned status is one of: IN_PROGRESS (Instagram is still fetching/encoding), FINISHED (ready to publish), ERROR (Instagram rejected it), EXPIRED (container is older than 24h), PUBLISHED (already published).",
    inputShape: {
      container_id: z.string(),
    },
    outputShape: {
      container_id: z.string(),
      status: ContainerStatus,
      status_code: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const res = await fetchContainerStatus(client, input.container_id);
      return {
        container_id: input.container_id,
        status: res.status,
        status_code: res.status_code,
      };
    },
  },
  {
    name: "instagram_publish_container",
    title: "Publish a finished container",
    description:
      "Finalize and publish a container that is in FINISHED status. Returns the resulting media_id. Pair with instagram_create_container + instagram_get_container_status for scheduled posting.",
    inputShape: {
      container_id: z.string(),
    },
    outputShape: {
      media_id: z.string(),
      published_at: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const igUserId = await client.igUserId();
      const res = await client.request<{ id: string }>(`/${igUserId}/media_publish`, {
        method: "POST",
        query: { creation_id: input.container_id },
      });
      return {
        media_id: res.id,
        published_at: new Date().toISOString(),
      };
    },
  },
];
