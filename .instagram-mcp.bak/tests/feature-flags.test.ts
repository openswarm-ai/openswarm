import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterEnabledTools } from "../src/tool-registry.js";
import { accountTools } from "../src/tools/account.js";
import { authTools } from "../src/tools/auth.js";
import { commentTools } from "../src/tools/comments.js";
import { containerTools } from "../src/tools/containers.js";
import { discoveryTools } from "../src/tools/discovery.js";
import { hashtagTools } from "../src/tools/hashtags.js";
import { insightsTools } from "../src/tools/insights.js";
import { mediaTools } from "../src/tools/media.js";
import { mentionTools } from "../src/tools/mentions.js";
import { messageTools } from "../src/tools/messages.js";
import { publishTools } from "../src/tools/publish.js";

const allTools = [
  ...authTools,
  ...accountTools,
  ...mediaTools,
  ...insightsTools,
  ...commentTools,
  ...hashtagTools,
  ...discoveryTools,
  ...mentionTools,
  ...publishTools,
  ...containerTools,
  ...messageTools,
];

const originalEnv = { ...process.env };

describe("feature flag → tool registration", () => {
  beforeEach(() => {
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_PUBLISHING", "");
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_COMMENTMODERATION", "");
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_MESSAGING", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...originalEnv };
  });

  it("ships 18 tools with all flags off (v0.1.x baseline)", () => {
    const enabled = filterEnabledTools(allTools);
    expect(enabled).toHaveLength(18);
    const names = enabled.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "instagram_business_discovery",
        "instagram_connect",
        "instagram_get_account_insights",
        "instagram_get_audience_insights",
        "instagram_get_hashtag_recent_media",
        "instagram_get_hashtag_top_media",
        "instagram_get_media",
        "instagram_get_media_insights",
        "instagram_get_mentioned_comment",
        "instagram_get_mentioned_media",
        "instagram_get_story_insights",
        "instagram_list_comment_replies",
        "instagram_list_comments",
        "instagram_list_recent_media",
        "instagram_logout",
        "instagram_search_hashtag",
        "instagram_status",
        "instagram_who_am_i",
      ].sort(),
    );
  });

  it("adds 9 publishing tools when publishing enabled → 27", () => {
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_PUBLISHING", "true");
    const enabled = filterEnabledTools(allTools);
    expect(enabled).toHaveLength(27);
  });

  it("adds 4 comment-moderation tools when only that flag is on → 22", () => {
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_COMMENTMODERATION", "true");
    const enabled = filterEnabledTools(allTools);
    expect(enabled).toHaveLength(22);
  });

  it("adds 3 messaging tools when only that flag is on → 21", () => {
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_MESSAGING", "true");
    const enabled = filterEnabledTools(allTools);
    expect(enabled).toHaveLength(21);
  });

  it("registers every tool when all flags on → 34", () => {
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_PUBLISHING", "true");
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_COMMENTMODERATION", "true");
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_MESSAGING", "true");
    const enabled = filterEnabledTools(allTools);
    expect(enabled).toHaveLength(34);
  });

  it("does NOT enable a feature for arbitrary truthy strings", () => {
    vi.stubEnv("INSTAGRAM_MCP_ENABLE_PUBLISHING", "1");
    const enabled = filterEnabledTools(allTools);
    expect(enabled).toHaveLength(18);
  });
});
