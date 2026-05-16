#!/usr/bin/env node
import "./env-bootstrap.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthState } from "./auth-state.js";
import { loadConfig } from "./config.js";
import { enabledFlags } from "./feature-flags.js";
import { GraphClient } from "./graph-client.js";
import { InstagramMcpError } from "./errors.js";
import { log, setLogLevel } from "./logger.js";
import { hasInjectedCredentials } from "./oauth-config.js";
import { runPublishedBuddySubprocess, shouldUseNpmOAuthFallback } from "./npm-connect-fallback.js";
import { buildServer } from "./server.js";

/**
 * One-shot OAuth for desktop hosts (OpenSwarm Electron). Writes a single JSON
 * line to stdout; all diagnostics go to stderr (same rule as MCP stdio).
 */
export async function runConnectCli(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);
  log.info("connect_cli_starting", { embeddedCredentials: hasInjectedCredentials() });
  if (shouldUseNpmOAuthFallback()) {
    log.info("connect_cli_delegating_npm");
    process.stderr.write(
      "instagram-mcp-buddy: no embedded Meta app in this build — running OAuth via `npx -y instagram-mcp-buddy connect` (requires network). Set INSTAGRAM_MCP_NO_NPX_FALLBACK=1 to fail fast instead.\n",
    );
    await runPublishedBuddySubprocess("connect", { forwardStdoutJsonLine: true });
    return;
  }
  const authState = await AuthState.create();
  await authState.connect();
  const client = new GraphClient(config, authState);
  let username: string | undefined;
  try {
    const me = await client.request<{ username?: string }>("/me", {
      query: { fields: "user_id,username" },
    });
    username = me.username;
  } catch (err) {
    log.warn("connect_cli_username_fetch_failed", { reason: (err as Error).message });
  }
  const igUserId = (await authState.getUserId()) ?? "";
  const payload = {
    ok: true as const,
    ig_user_id: igUserId,
    username,
    granted_scopes: authState.getGrantedScopes(),
    enabled_features: enabledFlags(),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export async function runLogoutCli(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);
  const authState = await AuthState.create();
  await authState.disconnect();
  process.stdout.write(`${JSON.stringify({ ok: true as const, disconnected: true })}\n`);
}

export async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  log.info("instagram_mcp_buddy_starting", {
    version: "0.1.0",
    graphApiVersion: config.IG_GRAPH_API_VERSION,
    enabledFeatures: enabledFlags(),
    embeddedCredentials: hasInjectedCredentials(),
  });

  const { server, authState, registeredToolCount } = await buildServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  log.info(
    authState.isConnected() ? "instagram_mcp_buddy_ready" : "instagram_mcp_buddy_ready_unconnected",
    {
      connected: authState.isConnected(),
      tools: registeredToolCount,
    },
  );

  const shutdown = (signal: string) => {
    log.info("instagram_mcp_buddy_shutdown", { signal });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const argvCmd = process.argv[2];
if (argvCmd === "connect") {
  runConnectCli().catch((err) => {
    const msg = err instanceof InstagramMcpError ? err.message : (err as Error).message;
    log.error("instagram_mcp_connect_cli_fatal", { error: msg });
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
} else if (argvCmd === "logout") {
  runLogoutCli().catch((err) => {
    log.error("instagram_mcp_logout_cli_fatal", { error: (err as Error).message });
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    log.error("instagram_mcp_buddy_fatal", { error: (err as Error).message });
    process.exit(1);
  });
}
