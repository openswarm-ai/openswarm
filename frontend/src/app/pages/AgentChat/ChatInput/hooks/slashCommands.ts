import { API_BASE, getAuthToken } from '@/shared/config';

/** Handles /context, /compact, /clear; returns true if intercepted so the prompt isn't sent to the agent. */
export async function handleSlashCommand(cmd: string, sessionId: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  if (cmd === '/context') {
    window.dispatchEvent(new CustomEvent('openswarm:context-drawer', { detail: { sessionId, open: true } }));
    return true;
  }
  // /compact and /clear mount at /api/agents/sessions/{id}/..., not under the agents SubApp.
  if (cmd === '/compact') {
    try {
      await fetch(`${API_BASE}/agents/sessions/${sessionId}/compact`, { method: 'POST', headers });
    } catch {}
    return true;
  }
  if (cmd === '/clear') {
    try {
      await fetch(`${API_BASE}/agents/sessions/${sessionId}/clear`, { method: 'POST', headers });
    } catch {}
    return true;
  }
  return false;
}
