import { parseMcpToolName } from '@/app/pages/AgentChat/toolkit/approval-utils';

export function getToolDisplayName(toolName: string): string {
    const mcp = parseMcpToolName(toolName);
    if (mcp.isMcp) return mcp.displayName;
    return toolName;
}