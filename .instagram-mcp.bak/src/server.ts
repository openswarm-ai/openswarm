import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthState } from "./auth-state.js";
import type { Config } from "./config.js";
import { GraphClient } from "./graph-client.js";
import {
  filterEnabledTools,
  registerTools,
  type AnyToolDefinition,
} from "./tool-registry.js";
import { accountTools } from "./tools/account.js";
import { authTools } from "./tools/auth.js";
import { commentTools } from "./tools/comments.js";
import { containerTools } from "./tools/containers.js";
import { discoveryTools } from "./tools/discovery.js";
import { hashtagTools } from "./tools/hashtags.js";
import { insightsTools } from "./tools/insights.js";
import { mediaTools } from "./tools/media.js";
import { mentionTools } from "./tools/mentions.js";
import { messageTools } from "./tools/messages.js";
import { publishTools } from "./tools/publish.js";

export interface BuildServerResult {
  server: McpServer;
  authState: AuthState;
  client: GraphClient;
  registeredToolCount: number;
}

export async function buildServer(config: Config): Promise<BuildServerResult> {
  const server = new McpServer({
    name: "instagram-mcp-buddy",
    version: "0.1.0",
  });
  const authState = await AuthState.create();
  const client = new GraphClient(config, authState);

  // Auth tools first so agents can discover instagram_connect / instagram_status
  // even before any account is linked. Feature-gated tools come after.
  const allTools: AnyToolDefinition[] = [
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

  const enabled = filterEnabledTools(allTools);
  registerTools(server, client, enabled);

  return {
    server,
    authState,
    client,
    registeredToolCount: enabled.length,
  };
}
