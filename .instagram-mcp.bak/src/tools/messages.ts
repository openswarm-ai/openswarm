import { z } from "zod";
import type { AnyToolDefinition } from "../tool-registry.js";

interface RawConversation {
  id: string;
  updated_time?: string;
  unread_count?: number;
  message_count?: number;
  participants?: { data?: Array<{ id?: string; username?: string }> };
}

interface RawMessage {
  id: string;
  created_time?: string;
  message?: string;
  from?: { id?: string; username?: string };
  to?: { data?: Array<{ id?: string; username?: string }> };
}

const ConversationItem = {
  conversation_id: z.string(),
  participant_username: z.string().optional(),
  participant_id: z.string().optional(),
  updated_at: z.string().optional(),
  message_count: z.number().int().optional(),
  unread_count: z.number().int().optional(),
};

const MessageItem = {
  message_id: z.string(),
  from_id: z.string().optional(),
  from_username: z.string().optional(),
  to_id: z.string().optional(),
  created_time: z.string().optional(),
  message: z.string().optional(),
};

export const messageTools: AnyToolDefinition[] = [
  {
    name: "instagram_list_conversations",
    title: "List DM conversations",
    description:
      "List recent direct-message conversations on the account. Requires the instagram_manage_messages permission. Returns conversation_id values you can pass to instagram_list_messages.",
    inputShape: {
      limit: z.number().int().min(1).max(50).default(25),
      after_cursor: z.string().optional(),
    },
    outputShape: {
      items: z.array(z.object(ConversationItem)),
      next_cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    requiredFeature: "messaging",
    handler: async (input, client) => {
      const query: Record<string, string | number> = {
        platform: "instagram",
        fields: "id,updated_time,unread_count,message_count,participants",
        limit: input.limit,
      };
      if (input.after_cursor) query.after = input.after_cursor;
      const igUserId = await client.igUserId();
      const { items, nextCursor } = await client.paginate<RawConversation>(
        `/${igUserId}/conversations`,
        { query, maxItems: input.limit },
      );
      return {
        items: items.map((c) => {
          const other = (c.participants?.data ?? []).find(
            (p) => p.id !== igUserId,
          );
          return {
            conversation_id: c.id,
            participant_username: other?.username,
            participant_id: other?.id,
            updated_at: c.updated_time,
            message_count: c.message_count,
            unread_count: c.unread_count,
          };
        }),
        next_cursor: nextCursor,
      };
    },
  },
  {
    name: "instagram_list_messages",
    title: "List messages in a conversation",
    description: "List messages in a DM conversation, newest first.",
    inputShape: {
      conversation_id: z.string(),
      limit: z.number().int().min(1).max(50).default(25),
      after_cursor: z.string().optional(),
    },
    outputShape: {
      items: z.array(z.object(MessageItem)),
      next_cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    requiredFeature: "messaging",
    handler: async (input, client) => {
      const query: Record<string, string | number> = {
        fields: "id,created_time,message,from,to",
        limit: input.limit,
      };
      if (input.after_cursor) query.after = input.after_cursor;
      const { items, nextCursor } = await client.paginate<RawMessage>(
        `/${input.conversation_id}/messages`,
        { query, maxItems: input.limit },
      );
      return {
        items: items.map((m) => ({
          message_id: m.id,
          from_id: m.from?.id,
          from_username: m.from?.username,
          to_id: m.to?.data?.[0]?.id,
          created_time: m.created_time,
          message: m.message,
        })),
        next_cursor: nextCursor,
      };
    },
  },
  {
    name: "instagram_send_message",
    title: "Send a DM",
    description:
      "Send a direct message to a user. CRITICAL constraint per Meta Messenger Platform: free-form messages are only allowed within 24 hours of the recipient's last message to your account. Outside that window you must pass a message_tag (currently only HUMAN_AGENT is supported and itself requires special permission). Recipients are addressed by their Instagram-scoped user id (igsid), which you obtain from instagram_list_messages.",
    inputShape: {
      recipient_id: z.string().describe("Instagram-scoped user id (IGSID) of the recipient."),
      text: z.string().min(1).max(1000),
      message_tag: z
        .enum(["HUMAN_AGENT"])
        .optional()
        .describe("Set only when messaging outside the 24h window."),
    },
    outputShape: {
      message_id: z.string(),
      recipient_id: z.string(),
      created_at: z.string(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    requiredFeature: "messaging",
    handler: async (input, client) => {
      const body: Record<string, unknown> = {
        recipient: { id: input.recipient_id },
        message: { text: input.text },
        messaging_type: input.message_tag ? "MESSAGE_TAG" : "RESPONSE",
      };
      if (input.message_tag) body.tag = input.message_tag;
      const igUserId = await client.igUserId();
      const res = await client.request<{ message_id?: string; recipient_id?: string }>(
        `/${igUserId}/messages`,
        { method: "POST", body },
      );
      return {
        message_id: res.message_id ?? "",
        recipient_id: res.recipient_id ?? input.recipient_id,
        created_at: new Date().toISOString(),
      };
    },
  },
];
