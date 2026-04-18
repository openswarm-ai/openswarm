import { parseMcpToolName } from '@/app/pages/AgentChat/toolkit/approvalToolkit/utils';

export function getToolDisplayName(toolName: string): string {
    const mcp = parseMcpToolName(toolName);
    if (mcp.isMcp) return mcp.displayName;
    return toolName;
}