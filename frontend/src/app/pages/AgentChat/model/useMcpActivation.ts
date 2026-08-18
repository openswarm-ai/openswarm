import { useCallback, useState } from 'react';
import { API_BASE, getAuthToken } from '@/shared/config';
import { openMarketplace } from '@/app/pages/Directory/openMarketplace';
import { clearMcpSuggestions } from '@/shared/state/agentsSlice';
import type { useAppDispatch } from '@/shared/hooks';

export interface McpSuggestion {
  id: string;
  title: string;
  description: string;
  reason?: string;
}

// Shared activation state + handler for the preflight MCP-connect suggestions, which render in two places
// (the in-transcript connect offer and the docked composer banner). Owns the in-flight id + error so both
// surfaces stay in lockstep. `ownerId` is the session whose suggestions get cleared on success.
export interface McpActivation {
  activatingId: string | null;
  error: string | null;
  activate: (s: McpSuggestion, parentSessionId: string) => Promise<void>;
}

export function useMcpActivation(dispatch: ReturnType<typeof useAppDispatch>, ownerId: string | undefined): McpActivation {
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activate = useCallback(async (s: McpSuggestion, parentSessionId: string) => {
    if (activatingId) return;
    setError(null);
    setActivatingId(s.id);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      const r = await fetch(`${API_BASE}/mcp-meta/activate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          server_name: s.id.toLowerCase().replace(/\s+/g, '-'),
          reason: s.reason || 'preflight suggestion',
          parent_session_id: parentSessionId,
        }),
      });
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        setError(`Activation failed (${r.status})`);
      } else if (body?.status === 'unknown_server') {
        // Not yet connected; jump to the store's connectors so the user can finish OAuth. Nothing here can do it on their behalf.
        openMarketplace('my-connectors');
      } else if (ownerId) {
        // Activation succeeded; clear the banner so the user gets visual confirmation the click did something.
        dispatch(clearMcpSuggestions({ sessionId: ownerId }));
      }
    } catch (e: any) {
      setError(e?.message || 'Activation failed');
    } finally {
      setActivatingId(null);
    }
  }, [activatingId, ownerId, dispatch]);

  return { activatingId, error, activate };
}
