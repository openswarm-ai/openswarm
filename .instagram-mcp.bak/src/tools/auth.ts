import { z } from "zod";
import { enabledFlags } from "../feature-flags.js";
import type { GraphClient } from "../graph-client.js";
import { log } from "../logger.js";
import type { AnyToolDefinition } from "../tool-registry.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function fetchUsernameSafe(client: GraphClient): Promise<string | undefined> {
  try {
    const res = await client.request<{ username?: string; user_id?: string }>("/me", {
      query: { fields: "user_id,username" },
    });
    return res.username;
  } catch (err) {
    log.warn("auth_tools_fetch_username_failed", {
      reason: (err as Error).message,
    });
    return undefined;
  }
}

function daysUntil(expiresAt: number): number {
  return Math.max(0, Math.floor((expiresAt - Date.now()) / MS_PER_DAY));
}

export const authTools: AnyToolDefinition[] = [
  {
    name: "instagram_connect",
    title: "Connect Instagram",
    description:
      "Sign the user into their Instagram Business or Creator account. Opens the user's default browser to the official Instagram OAuth page. After they approve, the long-lived access token is stored in their OS keychain (or an encrypted file fallback) on their own machine. Returns the connected account's username and the set of features unlocked by this build.",
    inputShape: {},
    outputShape: {
      connected: z.boolean(),
      username: z.string().optional(),
      ig_user_id: z.string(),
      granted_scopes: z.array(z.string()),
      enabled_features: z.array(z.string()),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (_input, client) => {
      const token = await client.auth.connect();
      const username = await fetchUsernameSafe(client);
      return {
        connected: true,
        username,
        ig_user_id: token.user_id,
        granted_scopes: token.granted_scopes,
        enabled_features: enabledFlags(),
      };
    },
  },
  {
    name: "instagram_logout",
    title: "Log out of Instagram",
    description:
      "Clear the stored Instagram access token from this machine. The agent should call this if the user asks to disconnect, switch accounts, or wipe credentials. After logout, instagram_connect must be called again before any non-auth tool will work.",
    inputShape: {},
    outputShape: { disconnected: z.boolean() },
    annotations: { destructiveHint: true, openWorldHint: false },
    handler: async (_input, client) => {
      await client.auth.disconnect();
      return { disconnected: true };
    },
  },
  {
    name: "instagram_status",
    title: "Instagram connection status",
    description:
      "Report whether Instagram is currently connected and which capabilities are available in this build of instagram-mcp-buddy. Agents should call this first to discover what they can do — features unlock over time as Meta App Review approves additional permissions. Safe to call before instagram_connect.",
    inputShape: {},
    outputShape: {
      connected: z.boolean(),
      username: z.string().optional(),
      ig_user_id: z.string().optional(),
      expires_at: z.string().optional(),
      days_until_refresh: z.number().int().optional(),
      enabled_features: z.array(z.string()),
      granted_scopes: z.array(z.string()),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (_input, client) => {
      const features = enabledFlags();
      const connected = client.auth.isConnected();
      if (!connected) {
        return {
          connected: false,
          enabled_features: features,
          granted_scopes: [],
        };
      }
      const igUserId = (await client.auth.getUserId()) ?? undefined;
      const expiresAt = client.auth.getExpiresAt();
      const username = await fetchUsernameSafe(client);
      return {
        connected: true,
        username,
        ig_user_id: igUserId,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        days_until_refresh: expiresAt ? daysUntil(expiresAt) : undefined,
        enabled_features: features,
        granted_scopes: client.auth.getGrantedScopes(),
      };
    },
  },
];
