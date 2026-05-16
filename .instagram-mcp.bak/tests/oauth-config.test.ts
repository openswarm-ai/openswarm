import { afterEach, describe, expect, it, vi } from "vitest";

describe("hasInjectedCredentials", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.INSTAGRAM_MCP_APP_ID;
    delete process.env.INSTAGRAM_MCP_APP_SECRET;
  });

  it("is false for empty env strings", async () => {
    process.env.INSTAGRAM_MCP_APP_ID = "";
    process.env.INSTAGRAM_MCP_APP_SECRET = "";
    const { hasInjectedCredentials } = await import("../src/oauth-config.js");
    expect(hasInjectedCredentials()).toBe(false);
  });

  it("is false for whitespace-only", async () => {
    process.env.INSTAGRAM_MCP_APP_ID = "  ";
    process.env.INSTAGRAM_MCP_APP_SECRET = "\t";
    const { hasInjectedCredentials } = await import("../src/oauth-config.js");
    expect(hasInjectedCredentials()).toBe(false);
  });

  it("is true for non-placeholder id and secret", async () => {
    process.env.INSTAGRAM_MCP_APP_ID = "real";
    process.env.INSTAGRAM_MCP_APP_SECRET = "secret";
    const { hasInjectedCredentials } = await import("../src/oauth-config.js");
    expect(hasInjectedCredentials()).toBe(true);
  });
});
