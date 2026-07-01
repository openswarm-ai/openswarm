// Shared connect primitive: create the tool (if needed) -> start OAuth / device-code -> open the
// popup -> poll status until connected. Lives in shared/ so both the Tools page and Onboarding use
// the SAME proven flow (downward abstraction), instead of each re-implementing it.

import { useCallback } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { createTool, startOAuth, startDeviceCodeLogin, fetchToolStatus, ToolDefinition } from '@/shared/state/toolsSlice';
import { Integration } from './catalog';

const POLL_MS = 2000;
const POLL_MAX = 60; // ~2 min

export interface ConnectResult {
  status: 'connected' | 'cancelled' | 'error';
}

export function useConnectIntegration(): (integration: Integration, existing?: ToolDefinition) => Promise<ConnectResult> {
  const dispatch = useAppDispatch();

  return useCallback(async (integration: Integration, existing?: ToolDefinition): Promise<ConnectResult> => {
    try {
      // The tool must exist before OAuth (fresh installs have none) -> create from the catalog.
      let tool = existing;
      if (!tool) {
        tool = await dispatch(createTool({
          name: integration.name,
          description: integration.description,
          mcp_config: integration.mcp_config,
          auth_type: integration.authType ?? 'oauth2',
        })).unwrap();
      }

      if (integration.authType === 'device_code') {
        await dispatch(startDeviceCodeLogin(tool.id));
        return { status: 'connected' };
      }

      const { auth_url } = await dispatch(startOAuth(tool.id)).unwrap();
      if (!auth_url) return { status: 'error' };
      // Named popup + features = the pattern that actually opens in Electron (a bare _blank is swallowed).
      window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');

      // Poll until the OAuth round-trip flips auth_status to connected.
      for (let i = 0; i < POLL_MAX; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const t = await dispatch(fetchToolStatus(tool.id)).unwrap();
        if (t.auth_status === 'connected') return { status: 'connected' };
      }
      return { status: 'cancelled' };
    } catch {
      return { status: 'error' };
    }
  }, [dispatch]);
}
