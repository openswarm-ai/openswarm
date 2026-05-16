/**
 * Single source of truth for which tools light up in the current build.
 *
 * Versioning contract:
 *   v0.1.x = read-only baseline. All flags below false.
 *   v0.2.x = +publishing.
 *   v0.3.x = +commentModeration.
 *   v0.4.x = +messaging.
 *
 * Bumped by hand per Meta App Review approval, then re-published to npm.
 * Users on `npx -y instagram-mcp-buddy` pick up the new flags on their next run.
 *
 * The INSTAGRAM_MCP_ENABLE_* env-var overrides let app admins (i.e. the
 * developer running their own Meta dev app) exercise pre-approval tools
 * locally without re-publishing the package.
 */

export const FEATURES = {
  /**
   * `instagram_business_content_publish` — hardest Meta App Review.
   * Gates: all 5 publish_* tools, all 3 container ops, delete_media.
   */
  publishing: false,
  /**
   * The WRITE half of `instagram_business_manage_comments`. List endpoints
   * stay always-on because the same scope grants both read and write.
   * Gates: reply_to_comment, delete_comment, hide_comment, toggle_comments.
   */
  commentModeration: false,
  /**
   * `instagram_business_manage_messages` — also a hard review.
   * Gates: list_conversations, list_messages, send_message.
   */
  messaging: false,
} as const;

export type FeatureFlag = keyof typeof FEATURES;

const envOverride = (name: FeatureFlag): boolean =>
  process.env[`INSTAGRAM_MCP_ENABLE_${name.toUpperCase()}`] === "true";

export function isEnabled(flag: FeatureFlag): boolean {
  return FEATURES[flag] || envOverride(flag);
}

export function enabledFlags(): FeatureFlag[] {
  return (Object.keys(FEATURES) as FeatureFlag[]).filter(isEnabled);
}
