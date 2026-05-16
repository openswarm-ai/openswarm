import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape, z } from "zod";
import { type FeatureFlag, isEnabled } from "./feature-flags.js";
import type { GraphClient } from "./graph-client.js";
import { log } from "./logger.js";

export interface ToolDefinition<
  TInputShape extends ZodRawShape,
  TOutputShape extends ZodRawShape,
> {
  name: string;
  title: string;
  description: string;
  inputShape: TInputShape;
  outputShape: TOutputShape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** When set, the tool is skipped at registration if the flag is disabled. */
  requiredFeature?: FeatureFlag;
  handler: (
    input: { [K in keyof TInputShape]: z.infer<TInputShape[K]> },
    client: GraphClient,
  ) => Promise<{ [K in keyof TOutputShape]: z.infer<TOutputShape[K]> }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export function filterEnabledTools(tools: AnyToolDefinition[]): AnyToolDefinition[] {
  const enabled: AnyToolDefinition[] = [];
  for (const tool of tools) {
    if (tool.requiredFeature && !isEnabled(tool.requiredFeature)) {
      log.info("tool_skipped_disabled_feature", {
        name: tool.name,
        feature: tool.requiredFeature,
      });
      continue;
    }
    enabled.push(tool);
  }
  return enabled;
}

export function registerTools(
  server: McpServer,
  client: GraphClient,
  tools: AnyToolDefinition[],
): void {
  // Filter already applied by the caller. Iterate as-is.
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        outputSchema: tool.outputShape,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.annotations?.readOnlyHint ?? false,
          destructiveHint: tool.annotations?.destructiveHint ?? false,
          idempotentHint: tool.annotations?.idempotentHint ?? false,
          openWorldHint: tool.annotations?.openWorldHint ?? true,
        },
      },
      async (rawInput: unknown) => {
        try {
          const result = await tool.handler(
            rawInput as Parameters<typeof tool.handler>[0],
            client,
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("tool_error", { tool: tool.name, message });
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      },
    );
    log.debug("tool_registered", { name: tool.name });
  }
}
