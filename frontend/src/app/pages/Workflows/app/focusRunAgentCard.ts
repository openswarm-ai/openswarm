// A workflow run IS an agent chat, so every "view this run" gesture lands on the real agent card
// on the canvas, never the old monitor pane (Eric: that form should not exist for runs).
import { store } from '@/shared/state/store';
import { API_BASE } from '@/shared/config';
import { expandSession } from '@/shared/state/agentsSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';

const POLL_MS = 700;
const MAX_POLLS = 36;

interface RunRow { id: string; session_id?: string | null; status?: string }

function focus(sessionId: string): void {
  store.dispatch(expandSession(sessionId));
  store.dispatch(setPendingFocusAgentId(sessionId));
}

/** Focus the agent card for a run. No runId = the newest run that has a chat. Polls while the
 * runner is still attaching its session, so pressing Run lands on the card as it spawns. */
export function focusRunAgentCard(workflowId: string, runId?: string): void {
  let polls = 0;
  const tick = async (): Promise<void> => {
    polls += 1;
    try {
      const res = await fetch(`${API_BASE}/workflows/${workflowId}/runs?limit=10`);
      const runs: RunRow[] = (await res.json())?.runs || [];
      const row = runId ? runs.find((r) => r.id === runId) : runs.find((r) => r.session_id);
      if (row?.session_id) { focus(row.session_id); return; }
      // A terminal run that never attached a chat (skipped before any agent) has nothing to focus.
      if (runId && row && row.status && row.status !== 'running') return;
    } catch { /* backend blip; keep polling inside the budget */ }
    if (polls < MAX_POLLS) window.setTimeout(() => { void tick(); }, POLL_MS);
  };
  void tick();
}
