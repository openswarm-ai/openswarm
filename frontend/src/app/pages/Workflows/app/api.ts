import { API_BASE, getAuthToken } from '@/shared/config';

function authHeaders(): Record<string, string> {
  let tok = '';
  try { tok = getAuthToken(); } catch { tok = ''; }
  return { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
}

const base = `${API_BASE}/workflows`;

// Sticky single edit-agent session for a workflow. The backend snapshots steps
// into draft_steps when it first hands one out; reattaches on later calls.
export async function ensureEditAgentSession(workflowId: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/${encodeURIComponent(workflowId)}/edit-agent-session`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.session_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// Send a chat question with a run's transcript riding along as hidden context
// for that single turn, so the answer is grounded in the run without an extra
// "I've reviewed it" round-trip. The user's bubble shows just their question.
export async function askRun(
  workflowId: string,
  body: { runId: string; prompt: string; mode?: string; model?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`${base}/${encodeURIComponent(workflowId)}/ask-run`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ run_id: body.runId, prompt: body.prompt, mode: body.mode, model: body.model }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
