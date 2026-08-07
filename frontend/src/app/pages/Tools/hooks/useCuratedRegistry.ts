import { useMemo } from 'react';
import type { McpServer } from '@/shared/state/mcpRegistrySlice';

// Curated whitelist matches the MCPSearch alias map in main.py (mcp-meta).
const CURATED_MCP_NAMES = new Set([
  'google-workspace', 'microsoft-365', 'slack', 'discord',
  'notion', 'airtable', 'hubspot', 'reddit', 'youtube',
]);

export function useCuratedRegistry(regServersRaw: McpServer[], regSource: string): McpServer[] {
  return useMemo(() => {
    if (regSource !== 'curated') return regServersRaw;
    return regServersRaw.filter((srv) => CURATED_MCP_NAMES.has((srv.name || '').toLowerCase()));
  }, [regServersRaw, regSource]);
}
