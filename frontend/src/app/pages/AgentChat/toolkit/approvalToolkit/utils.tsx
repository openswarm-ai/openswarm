import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntegrationMeta {
  label: string;
  color: string;
  icon: ReactNode;
}

export interface ParsedTool {
  isMcp: boolean;
  serverSlug: string;
  actionName: string;
  displayName: string;
}

export interface McpToolMeta {
  integration: IntegrationMeta | null;
  description: string;
  serverLabel: string;
}



// ---------------------------------------------------------------------------
// Parse / sanitize
// ---------------------------------------------------------------------------

export function parseMcpToolName(rawName: string): ParsedTool {
  const m = rawName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (!m) {
    return { isMcp: false, serverSlug: '', actionName: rawName, displayName: rawName };
  }
  const serverSlug = m[1];
  const actionName = m[2];
  const displayName = actionName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return { isMcp: true, serverSlug, actionName, displayName };
}