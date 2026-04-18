import { useMemo } from 'react';
import { useAppSelector } from '@/shared/hooks';
import type { ToolDefinition } from '@/shared/state/toolsSlice';
import {
  type ParsedTool, type McpToolMeta, type IntegrationMeta,
} from '../utils';


// ---------------------------------------------------------------------------
// Integration metadata (ported from approvalUtils.tsx)
// ---------------------------------------------------------------------------

const GoogleIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const RedditIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <circle cx="12" cy="12" r="12" fill="#FF4500"/>
    <path d="M19.5 12c0-.6-.5-1.1-1.1-1.1-.3 0-.6.1-.8.3-1-.7-2.3-1.1-3.7-1.1l.6-3 2.1.5c0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.6-.5-1.1-1.1-1.1-.4 0-.8.3-1 .6l-2.3-.5c-.1 0-.2 0-.2.1l-.7 3.3c-1.4 0-2.7.4-3.7 1.1-.2-.2-.5-.3-.8-.3-.6 0-1.1.5-1.1 1.1 0 .4.2.8.6 1-.1.3-.1.6-.1.9 0 2.3 2.6 4.1 5.8 4.1s5.8-1.8 5.8-4.1c0-.3 0-.6-.1-.9.4-.2.6-.6.6-1zm-9.8 1.1c0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1-.6 0-1.1-.5-1.1-1.1zm6.2 2.9c-.8.8-2 .9-2.9.9s-2.1-.1-2.9-.9c-.1-.1-.1-.3 0-.4.1-.1.3-.1.4 0 .6.6 1.6.8 2.5.8s1.9-.2 2.5-.8c.1-.1.3-.1.4 0 .1.1.1.3 0 .4zm-.2-1.8c-.6 0-1.1-.5-1.1-1.1 0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1z" fill="#fff"/>
  </svg>
);

const INTEGRATION_META: Record<string, IntegrationMeta> = {
  'Google Workspace': { label: 'Google Workspace', color: '#4285F4', icon: GoogleIcon },
  'xbird': { label: 'X / Twitter', color: '#1DA1F2', icon: <span style={{ fontSize: 14, fontWeight: 700 }}>𝕏</span> },
  'Reddit': { label: 'Reddit', color: '#FF4500', icon: RedditIcon },
};


function sanitizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function useMcpToolMeta(parsed: ParsedTool): McpToolMeta {
  const toolItems = useAppSelector((s) => s.tools.items);

  return useMemo(() => {
    if (!parsed.isMcp) {
      return { integration: null, description: '', serverLabel: '' };
    }

    const toolDef: ToolDefinition | undefined = Object.values(toolItems).find(
      (t) => t.mcp_config && Object.keys(t.mcp_config).length > 0
        && sanitizeServerName(t.name) === parsed.serverSlug,
    );

    if (!toolDef) {
      return { integration: null, description: '', serverLabel: parsed.serverSlug };
    }

    const description = toolDef.tool_permissions?._tool_descriptions?.[parsed.actionName] || '';
    const integration = INTEGRATION_META[toolDef.name] || null;
    const serverLabel = toolDef.name;

    return { integration, description, serverLabel };
  }, [parsed, toolItems]);
}
