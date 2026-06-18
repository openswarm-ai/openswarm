import { API_BASE, getAuthToken } from '@/shared/config';
import type { WorkflowStep } from '@/shared/state/workflowsSlice';
import { stepsSignature } from './scheduleUtils';

type OpenSidecar = (sessionId: string, kind: 'testing') => Promise<void>;

// Kick off a Test Agent run for the given (possibly-draft) steps and wire its
// session into the workflow card's sidecar. The signature rides along so a
// completed test run stamps the workflow as validated (see scheduleUtils +
// the test-run endpoint). Returns the session id, or null if it didn't start.
export async function runWorkflowTest(
  workflowId: string,
  steps: WorkflowStep[],
  openSidecar: OpenSidecar,
): Promise<string | null> {
  try {
    const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
    const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflowId)}/test-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: JSON.stringify({ steps, signature: stepsSignature(steps) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sid = data?.session_id as string | undefined;
    if (!sid) return null;
    await openSidecar(sid, 'testing');
    return sid;
  } catch {
    return null;
  }
}
