import { beforeEach, describe, expect, it, vi } from "vitest";

describe("shouldUseNpmOAuthFallback", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTAGRAM_MCP_NO_NPX_FALLBACK;
    delete process.env.INSTAGRAM_MCP_NPX_DELEGATE_CHILD;
    delete process.env.INSTAGRAM_MCP_APP_ID;
    delete process.env.INSTAGRAM_MCP_APP_SECRET;
  });

  it("is false when NO_NPX_FALLBACK=1", async () => {
    process.env.INSTAGRAM_MCP_NO_NPX_FALLBACK = "1";
    const { shouldUseNpmOAuthFallback } = await import("../src/npm-connect-fallback.js");
    expect(shouldUseNpmOAuthFallback()).toBe(false);
  });

  it("is false for npx delegate child (prevents recursion)", async () => {
    process.env.INSTAGRAM_MCP_NPX_DELEGATE_CHILD = "1";
    const { shouldUseNpmOAuthFallback } = await import("../src/npm-connect-fallback.js");
    expect(shouldUseNpmOAuthFallback()).toBe(false);
  });

  it("is false when app id+secret are set", async () => {
    process.env.INSTAGRAM_MCP_APP_ID = "x";
    process.env.INSTAGRAM_MCP_APP_SECRET = "y";
    const { shouldUseNpmOAuthFallback } = await import("../src/npm-connect-fallback.js");
    expect(shouldUseNpmOAuthFallback()).toBe(false);
  });

  it("is true when no embedded creds and not a delegate child", async () => {
    const { shouldUseNpmOAuthFallback } = await import("../src/npm-connect-fallback.js");
    expect(shouldUseNpmOAuthFallback()).toBe(true);
  });
});
