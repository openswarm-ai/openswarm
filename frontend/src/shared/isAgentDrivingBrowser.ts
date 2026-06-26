import type { AgentSession } from '@/shared/state/agentsSlice';

const ACTIVE_STATUSES = new Set<AgentSession['status']>(['running', 'waiting_approval']);

// True while an agent is actively running against this browser, so its webContents must survive a dashboard switch (the run keeps going in the background and the agent reaches it over CDP). A MANUAL browser is false: it stops rendering the moment you leave its dashboard, so it can't bleed onto another, and it reloads when you come back.
export function isAgentDrivingBrowser(
  sessions: Record<string, AgentSession>,
  browserId: string,
  spawnedBy?: string | null,
): boolean {
  for (const s of Object.values(sessions)) {
    if (s.browser_id === browserId && ACTIVE_STATUSES.has(s.status)) return true;
  }
  if (spawnedBy) {
    const parent = sessions[spawnedBy];
    if (parent && ACTIVE_STATUSES.has(parent.status)) return true;
  }
  return false;
}
