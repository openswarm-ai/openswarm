import type { ReactNode } from "react";

export type ToolUiToolkitRenderContext = {
  args?: unknown;
  result?: unknown;
  toolCallId?: string;
  addResult?: (result: unknown) => Promise<void> | void;
  [key: string]: unknown;
};

export function createResultToolRenderer<T>(options: {
  safeParse: (input: unknown) => T | null;
  render: (parsed: T, ctx: ToolUiToolkitRenderContext) => ReactNode;
}) {
  return (ctx: ToolUiToolkitRenderContext) => {
    const parsed = options.safeParse(ctx.result);
    if (!parsed) return null;
    return options.render(parsed, ctx);
  };
}
