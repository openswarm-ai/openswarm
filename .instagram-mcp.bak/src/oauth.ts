import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  API_BASE,
  AUTH_BASE,
  META_APP_ID,
  META_APP_SECRET,
  TOKEN_BASE,
  buildScopes,
  hasInjectedCredentials,
} from "./oauth-config.js";
import type { StoredToken } from "./token-store.js";
import { InstagramMcpError } from "./errors.js";
import { log } from "./logger.js";

const DEFAULT_PORT = 54321;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunOAuthFlowOpts {
  /**
   * Override the browser-opener (tests inject a function that programmatically
   * hits the callback URL). Default uses the `open` npm package.
   */
  openBrowser?: (url: string) => Promise<void>;
  /** Override port discovery (tests). */
  getPort?: () => Promise<number>;
  /** Cap how long we'll wait for the callback (tests). */
  timeoutMs?: number;
}

/**
 * Run the full OAuth dance: spin up a localhost callback server, open the
 * user's browser to Instagram's authorize page, exchange the code for a
 * short-lived token, then upgrade it to a long-lived 60-day token.
 */
export async function runOAuthFlow(opts: RunOAuthFlowOpts = {}): Promise<StoredToken> {
  if (!hasInjectedCredentials()) {
    throw new InstagramMcpError(
      "This build of instagram-mcp-buddy has no embedded Meta App credentials. " +
        "From a git checkout: copy instagram-mcp/.env.example to instagram-mcp/.env, set " +
        "INSTAGRAM_MCP_APP_ID and INSTAGRAM_MCP_APP_SECRET (Meta developer app), then run " +
        "`npm run build` — the CLI loads .env automatically — or bake secrets into dist with " +
        "`npm run build:inject`. Maintainers publishing to npm: run `npm run publish:npm` with " +
        "META_APP_ID and META_APP_SECRET set. " +
        "The `npx instagram-mcp-buddy connect` fallback only works if the published package " +
        "on npm was built with inject-credentials (not plain REPLACE_AT_BUILD).",
    );
  }

  const port = await (opts.getPort ?? findFreePort)();
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString("hex");
  const scopes = buildScopes();

  const authUrl = new URL(AUTH_BASE);
  authUrl.searchParams.set("client_id", META_APP_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(","));
  authUrl.searchParams.set("state", state);

  log.info("oauth_starting", { port, scopes });

  const codePromise = waitForCallback({
    port,
    expectedState: state,
    timeoutMs: opts.timeoutMs ?? CALLBACK_TIMEOUT_MS,
  });
  // The callback can fire (and reject) before `await openBrowser(...)` returns
  // — fast paths like programmatic browsers in tests, or instant CSRF/error
  // rejections. Attach a no-op handler so the runtime doesn't treat the
  // rejection as unhandled. The `await codePromise` below still re-throws.
  codePromise.catch(() => {
    /* handled by the await below */
  });

  await openBrowser(authUrl.toString(), opts.openBrowser);

  const code = await codePromise;
  log.info("oauth_code_received");

  const shortLived = await exchangeCodeForShortLivedToken(code, redirectUri);
  log.info("oauth_short_token_received", { user_id: shortLived.user_id });

  const longLived = await exchangeForLongLivedToken(shortLived.access_token);
  log.info("oauth_long_token_received", { expires_in: longLived.expires_in });

  return {
    access_token: longLived.access_token,
    user_id: String(shortLived.user_id),
    expires_at: Date.now() + longLived.expires_in * 1000,
    obtained_at: Date.now(),
    granted_scopes: scopes,
  };
}

/* -------------------------------------------------------------------------- */
/* Callback server                                                            */
/* -------------------------------------------------------------------------- */

interface WaitOpts {
  port: number;
  expectedState: string;
  timeoutMs: number;
}

function waitForCallback(opts: WaitOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let server: Server | undefined;
    const timer = setTimeout(() => {
      server?.close();
      reject(
        new InstagramMcpError(
          `Did not receive Instagram OAuth callback within ${opts.timeoutMs}ms. ` +
            "Either the browser was closed before authorization completed, or a " +
            "firewall is blocking localhost. Re-run instagram_connect and complete " +
            "the login in the browser tab that opens.",
        ),
      );
    }, opts.timeoutMs);

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        respondError(res, 400, "Bad request.");
        return;
      }
      const u = new URL(req.url, `http://localhost:${opts.port}`);
      if (u.pathname !== "/callback") {
        respondError(res, 404, "Not found.");
        return;
      }
      const err = u.searchParams.get("error");
      if (err) {
        const desc =
          u.searchParams.get("error_description") ??
          u.searchParams.get("error_reason") ??
          err;
        respondError(res, 400, `Instagram rejected authorization: ${desc}`);
        clearTimeout(timer);
        server?.close();
        reject(new InstagramMcpError(`Instagram rejected authorization: ${desc}`));
        return;
      }
      const state = u.searchParams.get("state");
      const code = u.searchParams.get("code");
      if (state !== opts.expectedState) {
        respondError(res, 400, "Authorization rejected: state mismatch.");
        clearTimeout(timer);
        server?.close();
        reject(
          new InstagramMcpError(
            "OAuth state mismatch — possible CSRF. Re-run instagram_connect.",
          ),
        );
        return;
      }
      if (!code) {
        respondError(res, 400, "Authorization rejected: no code returned.");
        clearTimeout(timer);
        server?.close();
        reject(new InstagramMcpError("Instagram returned no authorization code."));
        return;
      }
      respondSuccess(res);
      clearTimeout(timer);
      // Close after a short delay so the response can flush.
      setTimeout(() => server?.close(), 100);
      resolve(code);
    };

    server = createServer(handler);
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new InstagramMcpError(
          `Could not bind localhost:${opts.port} for the OAuth callback: ${err.message}`,
        ),
      );
    });
    server.listen(opts.port, "127.0.0.1");
  });
}

function respondSuccess(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #fafafa; color: #262626; display: grid; place-items: center;
    min-height: 100vh; margin: 0; }
  .card { background: #fff; padding: 48px; border-radius: 12px;
    box-shadow: 0 2px 24px rgba(0,0,0,0.06); max-width: 480px; text-align: center; }
  h1 { margin: 0 0 12px; font-size: 22px; }
  p { margin: 0; color: #555; line-height: 1.5; }
  .ig { background: linear-gradient(45deg,#FED576,#F47133,#BC3081,#4C63D2);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text; font-weight: 700; }
</style></head>
<body><div class="card">
<h1>Connected to <span class="ig">Instagram</span></h1>
<p>You can close this tab and return to your agent.</p>
</div></body></html>`);
}

function respondError(res: ServerResponse, status: number, msg: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

/* -------------------------------------------------------------------------- */
/* Token exchanges                                                            */
/* -------------------------------------------------------------------------- */

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: string | number;
}

async function exchangeCodeForShortLivedToken(
  code: string,
  redirectUri: string,
): Promise<ShortLivedTokenResponse> {
  const body = new URLSearchParams({
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(TOKEN_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new InstagramMcpError(
      `Failed to exchange code for short-lived token (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  let parsed: ShortLivedTokenResponse;
  try {
    parsed = JSON.parse(text) as ShortLivedTokenResponse;
  } catch {
    throw new InstagramMcpError(
      `Token exchange returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
  if (!parsed.access_token) {
    throw new InstagramMcpError("Token exchange returned no access_token.");
  }
  return parsed;
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
}

async function exchangeForLongLivedToken(
  shortLivedToken: string,
): Promise<LongLivedTokenResponse> {
  const url = new URL(`${API_BASE}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", META_APP_SECRET);
  url.searchParams.set("access_token", shortLivedToken);
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    throw new InstagramMcpError(
      `Failed to upgrade to long-lived token (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as LongLivedTokenResponse;
}

/* -------------------------------------------------------------------------- */
/* Refresh                                                                    */
/* -------------------------------------------------------------------------- */

export async function refreshAccessToken(currentToken: string): Promise<LongLivedTokenResponse> {
  const url = new URL(`${API_BASE}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", currentToken);
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    throw new InstagramMcpError(
      `Failed to refresh long-lived token (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as LongLivedTokenResponse;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function findFreePort(): Promise<number> {
  try {
    const mod = await import("get-port");
    const getPort = (mod.default ?? mod) as unknown as (
      opts?: { port?: number | number[] | { from: number; to: number } },
    ) => Promise<number>;
    return await getPort({ port: [DEFAULT_PORT, 54322, 54323, 54324, 54325] });
  } catch {
    return DEFAULT_PORT;
  }
}

async function openBrowser(
  url: string,
  override?: (url: string) => Promise<void>,
): Promise<void> {
  if (override) {
    await override(url);
    return;
  }
  try {
    const mod = await import("open");
    const open = (mod.default ?? mod) as unknown as (
      target: string,
    ) => Promise<unknown>;
    await open(url);
    log.info("oauth_browser_opened");
  } catch (err) {
    log.warn("oauth_browser_open_failed", { reason: (err as Error).message });
    // Surface the URL anyway so the user can paste it manually.
    process.stderr.write(
      `\ninstagram-mcp-buddy: open this URL in your browser to connect:\n  ${url}\n\n`,
    );
  }
}
