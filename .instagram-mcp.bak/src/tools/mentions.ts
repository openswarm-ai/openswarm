import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

export const mentionTools: AnyToolDefinition[] = [
  {
    name: "instagram_get_mentioned_comment",
    title: "Read a comment that mentioned the account",
    description:
      "Read a comment that @-mentioned your account. In production these comment ids arrive via the `mentions` webhook field. For testing/manual use, pass the comment id directly.",
    inputShape: { comment_id: z.string() },
    outputShape: {
      id: z.string(),
      text: z.string().optional(),
      username: z.string().optional(),
      timestamp: z.string().optional(),
      media_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const igUserId = await client.igUserId();
      const res = await client.request<{
        id: string;
        text?: string;
        username?: string;
        timestamp?: string;
        media?: { id?: string };
      }>(`/${igUserId}`, {
        query: {
          fields: `mentioned_comment.comment_id(${input.comment_id}){id,text,username,timestamp,media}`,
        },
      });
      // The Graph API nests under `mentioned_comment` on the user object.
      const wrapper = res as unknown as {
        mentioned_comment?: {
          id?: string;
          text?: string;
          username?: string;
          timestamp?: string;
          media?: { id?: string };
        };
      };
      const mc = wrapper.mentioned_comment;
      if (!mc?.id) {
        throw new Error(`No mentioned comment found for id ${input.comment_id}.`);
      }
      return {
        id: mc.id,
        text: mc.text,
        username: mc.username,
        timestamp: mc.timestamp,
        media_id: mc.media?.id,
      };
    },
  },
  {
    name: "instagram_get_mentioned_media",
    title: "Read a media post that tagged the account",
    description:
      "Read a public post that @-tagged your account. In production these media ids arrive via the `mentions` webhook field. For testing/manual use, pass the media id directly.",
    inputShape: { media_id: z.string() },
    outputShape: {
      id: z.string(),
      caption: z.string().optional(),
      media_type: z.string().optional(),
      media_url: z.string().optional(),
      permalink: z.string().optional(),
      timestamp: z.string().optional(),
      owner_username: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, client) => {
      const fields =
        "id,caption,media_type,media_url,permalink,timestamp,owner{username}";
      const igUserId = await client.igUserId();
      const res = await client.request<{
        mentioned_media?: {
          id?: string;
          caption?: string;
          media_type?: string;
          media_url?: string;
          permalink?: string;
          timestamp?: string;
          owner?: { username?: string };
        };
      }>(`/${igUserId}`, {
        query: { fields: `mentioned_media.media_id(${input.media_id}){${fields}}` },
      });
      const mm = res.mentioned_media;
      if (!mm?.id) {
        throw new Error(`No mentioned media found for id ${input.media_id}.`);
      }
      return {
        id: mm.id,
        caption: mm.caption,
        media_type: mm.media_type,
        media_url: mm.media_url,
        permalink: mm.permalink,
        timestamp: mm.timestamp,
        owner_username: mm.owner?.username,
      };
    },
  },
];
