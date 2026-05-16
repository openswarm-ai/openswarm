import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { URL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// Stub the embedded Meta credentials BEFORE importing oauth.ts.
process.env.INSTAGRAM_MCP_APP_ID = "test_app_id";
process.env.INSTAGRAM_MCP_APP_SECRET = "test_app_secret";

const { runOAuthFlow } = await import("../src/oauth.js");

/* -------------------------------------------------------------------------- */
/* Fake Instagram token endpoints                                             */
/* -------------------------------------------------------------------------- */

interface FakeServer {
  url: string;
  shortTokenHits: number;
  longTokenHits: number;
  lastShortTokenForm?: URLSearchParams;
  close(): Promise<void>;
}

// Bridge fetch calls targeting Instagram's real endpoints to the fake server.
let metaBaseUrl: string | null = null;
const originalFetch = globalThis.fetch;

function installFetchBridge(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rewritten = metaBaseUrl
      ? raw
          .replace("https://api.instagram.com", metaBaseUrl)
          .replace("https://graph.instagram.com", metaBaseUrl)
      : raw;
    return originalFetch(rewritten, init);
  }) as typeof fetch;
}

async function startFakeMetaServer(): Promise<FakeServer> {
  const state: FakeServer = {
    url: "",
    shortTokenHits: 0,
    longTokenHits: 0,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && u.pathname === "/oauth/access_token") {
      const body = await readBody(req);
      state.shortTokenHits += 1;
      state.lastShortTokenForm = new URLSearchParams(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "short_lived_token",
          user_id: "17841400000000099",
        }),
      );
      return;
    }
    if (req.method === "GET" && u.pathname === "/access_token") {
      state.longTokenHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "long_lived_token",
          token_type: "bearer",
          expires_in: 60 * 24 * 60 * 60,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${port}`;
  return state;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c.toString()));
    req.on("end", () => resolve(buf));
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

let meta: FakeServer;

beforeAll(async () => {
  meta = await startFakeMetaServer();
  metaBaseUrl = meta.url;
  installFetchBridge();
});

afterAll(async () => {
  metaBaseUrl = null;
  globalThis.fetch = originalFetch;
  await meta.close();
});

afterEach(() => {
  meta.shortTokenHits = 0;
  meta.longTokenHits = 0;
  meta.lastShortTokenForm = undefined;
});

describe("runOAuthFlow", () => {
  it("completes the full short→long token dance", async () => {
    const port = await pickFreePort();
    // Pretend the browser hit our local /callback the instant we ask it to.
    const openBrowser = async (authUrl: string): Promise<void> => {
      const parsed = new URL(authUrl);
      expect(parsed.origin + parsed.pathname).toBe(
        "https://www.instagram.com/oauth/authorize",
      );
      expect(parsed.searchParams.get("client_id")).toBe("test_app_id");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      const state = parsed.searchParams.get("state");
      const redirectUri = parsed.searchParams.get("redirect_uri");
      expect(state).toBeTruthy();
      expect(redirectUri).toBeTruthy();
      // Hit the callback URL programmatically.
      const cbUrl = new URL(redirectUri!);
      cbUrl.searchParams.set("code", "FAKE_AUTH_CODE");
      cbUrl.searchParams.set("state", state!);
      const res = await originalFetch(cbUrl);
      expect(res.status).toBe(200);
    };

    const token = await runOAuthFlow({
      openBrowser,
      getPort: async () => port,
      timeoutMs: 5_000,
    });

    expect(token.access_token).toBe("long_lived_token");
    expect(token.user_id).toBe("17841400000000099");
    expect(token.granted_scopes).toContain("instagram_business_basic");
    expect(token.expires_at).toBeGreaterThan(Date.now());
    expect(token.obtained_at).toBeGreaterThan(0);

    expect(meta.shortTokenHits).toBe(1);
    expect(meta.longTokenHits).toBe(1);

    expect(meta.lastShortTokenForm?.get("client_id")).toBe("test_app_id");
    expect(meta.lastShortTokenForm?.get("client_secret")).toBe("test_app_secret");
    expect(meta.lastShortTokenForm?.get("grant_type")).toBe("authorization_code");
    expect(meta.lastShortTokenForm?.get("code")).toBe("FAKE_AUTH_CODE");
  });

  it("rejects state mismatch (CSRF guard)", async () => {
    const port = await pickFreePort();
    const openBrowser = async (authUrl: string): Promise<void> => {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const cbUrl = new URL(redirectUri);
      cbUrl.searchParams.set("code", "FAKE_AUTH_CODE");
      cbUrl.searchParams.set("state", "BOGUS_STATE");
      await originalFetch(cbUrl).catch(() => undefined);
    };
    await expect(
      runOAuthFlow({ openBrowser, getPort: async () => port, timeoutMs: 3_000 }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it("rejects an error param from Instagram", async () => {
    const port = await pickFreePort();
    const openBrowser = async (authUrl: string): Promise<void> => {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const cbUrl = new URL(redirectUri);
      cbUrl.searchParams.set("error", "access_denied");
      cbUrl.searchParams.set("error_description", "user said no");
      await originalFetch(cbUrl).catch(() => undefined);
    };
    await expect(
      runOAuthFlow({ openBrowser, getPort: async () => port, timeoutMs: 3_000 }),
    ).rejects.toThrow(/user said no/);
  });

  it("times out cleanly if the browser never returns", async () => {
    const port = await pickFreePort();
    const openBrowser = vi.fn(async () => {
      /* never hit the callback */
    });
    await expect(
      runOAuthFlow({ openBrowser, getPort: async () => port, timeoutMs: 150 }),
    ).rejects.toThrow(/Did not receive Instagram OAuth callback/);
  });
});
