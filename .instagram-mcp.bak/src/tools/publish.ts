import { z } from "zod";
import { pollUntilFinished } from "../containers.js";
import type { GraphClient } from "../graph-client.js";
import type { AnyToolDefinition } from "../tool-registry.js";

const PublishResult = {
  media_id: z.string(),
  permalink: z.string().optional(),
  published_at: z.string(),
};

interface ContainerCreationParams {
  image_url?: string;
  video_url?: string;
  media_type?: "IMAGE" | "VIDEO" | "REELS" | "STORIES" | "CAROUSEL";
  caption?: string;
  is_carousel_item?: boolean;
  children?: string;
  share_to_feed?: boolean;
  cover_url?: string;
  location_id?: string;
  user_tags?: string;
  alt_text?: string;
  thumb_offset?: number;
}

async function createContainer(
  client: GraphClient,
  params: ContainerCreationParams,
): Promise<string> {
  const query: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) query[k] = v as string | number | boolean;
  }
  const igUserId = await client.igUserId();
  const res = await client.request<{ id: string }>(`/${igUserId}/media`, {
    method: "POST",
    query,
  });
  return res.id;
}

async function publishContainer(
  client: GraphClient,
  containerId: string,
): Promise<{ id: string }> {
  const igUserId = await client.igUserId();
  return client.request<{ id: string }>(`/${igUserId}/media_publish`, {
    method: "POST",
    query: { creation_id: containerId },
  });
}

async function fetchPermalink(
  client: GraphClient,
  mediaId: string,
): Promise<string | undefined> {
  try {
    const res = await client.request<{ permalink?: string }>(`/${mediaId}`, {
      query: { fields: "permalink" },
    });
    return res.permalink;
  } catch {
    return undefined;
  }
}

export const publishTools: AnyToolDefinition[] = [
  {
    name: "instagram_publish_image",
    title: "Publish image post",
    description:
      "Publish a single image post to Instagram in one call (creates container, polls until processed, then publishes). The image_url must be publicly accessible HTTPS (JPEG/PNG, ≤8MB, aspect ratio 4:5 to 1.91:1). Caption supports up to 2,200 chars, 30 hashtags, and 20 @mentions. Returns the resulting media_id and permalink.",
    inputShape: {
      image_url: z.string().url().describe("Public HTTPS URL to a JPEG or PNG (≤8MB)."),
      caption: z.string().max(2200).optional().describe("Post caption."),
      location_id: z.string().optional().describe("Optional Facebook Page location id."),
      alt_text: z.string().max(100).optional().describe("Accessibility alt text."),
    },
    outputShape: PublishResult,
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const containerId = await createContainer(client, {
        image_url: input.image_url,
        caption: input.caption,
        location_id: input.location_id,
        alt_text: input.alt_text,
      });
      await pollUntilFinished(client, containerId, client.config.IG_IMAGE_TIMEOUT_MS);
      const { id } = await publishContainer(client, containerId);
      const permalink = await fetchPermalink(client, id);
      return {
        media_id: id,
        permalink,
        published_at: new Date().toISOString(),
      };
    },
  },
  {
    name: "instagram_publish_carousel",
    title: "Publish carousel post",
    description:
      "Publish a 2–10 item carousel (mixed images and videos). Each item must be a publicly accessible HTTPS URL. All children are created in parallel, then assembled into a CAROUSEL container and published. Caption rules same as instagram_publish_image.",
    inputShape: {
      items: z
        .array(
          z.object({
            media_url: z.string().url(),
            media_type: z.enum(["IMAGE", "VIDEO"]),
          }),
        )
        .min(2)
        .max(10)
        .describe("Between 2 and 10 children."),
      caption: z.string().max(2200).optional(),
    },
    outputShape: {
      ...PublishResult,
      child_media_ids: z.array(z.string()),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const childIds = await Promise.all(
        input.items.map(async (item: { media_url: string; media_type: "IMAGE" | "VIDEO" }) =>
          createContainer(client, {
            ...(item.media_type === "VIDEO"
              ? { video_url: item.media_url, media_type: "VIDEO" as const }
              : { image_url: item.media_url }),
            is_carousel_item: true,
          }),
        ),
      );
      // Poll each child container.
      await Promise.all(
        childIds.map((id) =>
          pollUntilFinished(client, id, client.config.IG_IMAGE_TIMEOUT_MS),
        ),
      );
      const parentId = await createContainer(client, {
        media_type: "CAROUSEL",
        caption: input.caption,
        children: childIds.join(","),
      });
      await pollUntilFinished(client, parentId, client.config.IG_IMAGE_TIMEOUT_MS);
      const { id } = await publishContainer(client, parentId);
      const permalink = await fetchPermalink(client, id);
      return {
        media_id: id,
        permalink,
        published_at: new Date().toISOString(),
        child_media_ids: childIds,
      };
    },
  },
  {
    name: "instagram_publish_reel",
    title: "Publish Reel",
    description:
      "Publish a Reel. video_url must be MP4 (≤100MB, ≤90s, H.264 video + AAC audio) over HTTPS. Reels take longer to process — this tool polls for up to 5 minutes by default (configurable via IG_REEL_TIMEOUT_MS). share_to_feed=true (default) makes the Reel appear in the main feed as well as Reels tab.",
    inputShape: {
      video_url: z.string().url().describe("Public HTTPS MP4 URL."),
      caption: z.string().max(2200).optional(),
      cover_url: z.string().url().optional().describe("Optional cover image URL."),
      share_to_feed: z.boolean().default(true),
      thumb_offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Milliseconds into the video to use as the thumbnail."),
    },
    outputShape: PublishResult,
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const containerId = await createContainer(client, {
        media_type: "REELS",
        video_url: input.video_url,
        caption: input.caption,
        cover_url: input.cover_url,
        share_to_feed: input.share_to_feed,
        thumb_offset: input.thumb_offset,
      });
      await pollUntilFinished(client, containerId, client.config.IG_REEL_TIMEOUT_MS);
      const { id } = await publishContainer(client, containerId);
      const permalink = await fetchPermalink(client, id);
      return {
        media_id: id,
        permalink,
        published_at: new Date().toISOString(),
      };
    },
  },
  {
    name: "instagram_publish_story_image",
    title: "Publish image Story",
    description:
      "Publish an image to the account's Story. Stories expire 24 hours after publishing. image_url requirements same as a regular image post.",
    inputShape: {
      image_url: z.string().url(),
    },
    outputShape: {
      media_id: z.string(),
      expires_at: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const containerId = await createContainer(client, {
        media_type: "STORIES",
        image_url: input.image_url,
      });
      await pollUntilFinished(client, containerId, client.config.IG_IMAGE_TIMEOUT_MS);
      const { id } = await publishContainer(client, containerId);
      const now = Date.now();
      return {
        media_id: id,
        expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      };
    },
  },
  {
    name: "instagram_publish_story_video",
    title: "Publish video Story",
    description:
      "Publish a video to the account's Story. Videos must be ≤60s. Stories expire 24 hours after publishing.",
    inputShape: {
      video_url: z.string().url(),
    },
    outputShape: {
      media_id: z.string(),
      expires_at: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "publishing",
    handler: async (input, client) => {
      const containerId = await createContainer(client, {
        media_type: "STORIES",
        video_url: input.video_url,
      });
      await pollUntilFinished(client, containerId, client.config.IG_REEL_TIMEOUT_MS);
      const { id } = await publishContainer(client, containerId);
      const now = Date.now();
      return {
        media_id: id,
        expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      };
    },
  },
];
