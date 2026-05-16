/**
 * Embedded Meta App credentials.
 *
 * At publish time `scripts/inject-credentials.mjs` rewrites the
 * REPLACE_AT_BUILD placeholders in `dist/oauth-config.js` with the real prod
 * values. For local development, set INSTAGRAM_MCP_APP_ID and
 * INSTAGRAM_MCP_APP_SECRET in your shell against your own Meta dev app and
 * the env values win.
 *
 * Note that the app secret WILL ship inside the published npm artifact.
 * This is the standard installed-app OAuth tradeoff (Spotify desktop,
 * Vercel CLI, Notion, gh CLI all do the same). The actual security
 * boundary is the per-user access token, stored only in the user's OS
 * keychain on their own machine.
 */

import { isEnabled } from "./feature-flags.js";

export const META_APP_ID: string =
  process.env.INSTAGRAM_MCP_APP_ID ?? "REPLACE_AT_BUILD";
export const META_APP_SECRET: string =
  process.env.INSTAGRAM_MCP_APP_SECRET ?? "REPLACE_AT_BUILD";

/** Instagram Login API — 2024 flow, no Facebook Page required. */
export const AUTH_BASE = "https://www.instagram.com/oauth/authorize";
/** Short-lived token exchange. */
export const TOKEN_BASE = "https://api.instagram.com/oauth/access_token";
/** Long-lived token endpoint + Graph API root. */
export const API_BASE = "https://graph.instagram.com";

/**
 * Always-on scopes. Note that `instagram_business_manage_comments` is always
 * requested at OAuth time (it grants both read and write); the
 * `commentModeration` feature flag only controls whether the WRITE tools
 * are exposed in this build, not whether the scope is requested.
 */
const ALWAYS_ON_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
] as const;

/**
 * Compute the OAuth scope list for the current build. Adds the scopes for
 * any feature flag that is currently enabled (either at build time or via
 * env override).
 */
export function buildScopes(): string[] {
  const scopes = new Set<string>(ALWAYS_ON_SCOPES);
  if (isEnabled("publishing")) scopes.add("instagram_business_content_publish");
  if (isEnabled("messaging")) scopes.add("instagram_business_manage_messages");
  return [...scopes];
}

export function hasInjectedCredentials(): boolean {
  const id = META_APP_ID.trim();
  const secret = META_APP_SECRET.trim();
  return (
    id.length > 0 &&
    secret.length > 0 &&
    id !== "REPLACE_AT_BUILD" &&
    secret !== "REPLACE_AT_BUILD"
  );
}
