import { API_BASE, getAuthToken } from '@/shared/config';

// Mirrors backend/apps/workflows/cloud/status.py. `unknown` is a first-class answer, not a
// degraded `ready`: it carries no plan, no limits and no counts, so a failed fetch cannot be
// rendered as "you are not entitled" or "0 runs left".
export type CloudTarget = 'device' | 'cloud';

export interface CloudLimits {
  workflows: number;
  runs_per_month: number;
  concurrent: number;
}

export interface CloudUsage {
  workflows_enabled: number;
  runs_this_month: number;
}

export interface CloudCapability {
  ok: boolean;
  reason: string | null;
}

export interface HostedState {
  id: string;
  enabled: boolean;
  next_run_at: string | null;
  /** False when the workflow was edited after we pushed it, so the cloud holds older prose. */
  in_sync: boolean;
}

interface CloudStatusShared {
  target: CloudTarget;
  schedule_supported: boolean;
  schedule_reason: string | null;
}

/** Whether an AI account exists that the cloud could sign runs with. An API key alone cannot. */
export interface CloudCredential {
  state: 'ready' | 'none_eligible';
  connection_ids: string[];
  reason: string | null;
}

export interface CloudStatusReady extends CloudStatusShared {
  state: 'ready';
  plan: string | null;
  limits: CloudLimits;
  usage: CloudUsage;
  /** Null when the control plane could not tell us; create re-checks either way. */
  capability: CloudCapability | null;
  hosted: HostedState | null;
  credential: CloudCredential;
}

export interface CloudStatusSignedOut extends CloudStatusShared {
  state: 'signed_out';
}

export interface CloudStatusUnknown extends CloudStatusShared {
  state: 'unknown';
  detail: string;
}

// The signed-in cloud has no workflows API (its preflight route 404s): this app is ahead of it.
export interface CloudStatusUnavailable extends CloudStatusShared {
  state: 'unavailable';
  reason: string;
}

export type CloudStatus = CloudStatusReady | CloudStatusSignedOut | CloudStatusUnknown | CloudStatusUnavailable;

export interface CloudRun {
  id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  answer: string | null;
  notices: string[];
  cost_usd: number | null;
}

export type CloudRunsResponse =
  | { state: 'ready'; runs: CloudRun[] }
  | { state: 'signed_out' | 'unknown'; detail: string | null };

export interface TargetOutcome {
  ok: boolean;
  message: string | null;
}

const base = `${API_BASE}/cloud_workflows`;

function headers(): Record<string, string> {
  let tok = '';
  try { tok = getAuthToken(); } catch { tok = ''; }
  return { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
}

// Null means our own backend did not answer, which the caller must render as "cannot tell" rather than as a denial.
export async function fetchCloudStatus(workflowId: string): Promise<CloudStatus | null> {
  try {
    const res = await fetch(`${base}/${encodeURIComponent(workflowId)}/status`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as CloudStatus;
  } catch {
    return null;
  }
}

export async function fetchCloudRuns(workflowId: string): Promise<CloudRunsResponse> {
  try {
    const res = await fetch(`${base}/${encodeURIComponent(workflowId)}/runs`, { headers: headers() });
    if (!res.ok) return { state: 'unknown', detail: null };
    return (await res.json()) as CloudRunsResponse;
  } catch {
    return { state: 'unknown', detail: null };
  }
}

export async function setCloudTarget(
  workflowId: string,
  body: { target: CloudTarget; enabled: boolean },
): Promise<TargetOutcome> {
  try {
    const res = await fetch(`${base}/${encodeURIComponent(workflowId)}/target`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, message: 'Something went wrong on this machine, so nothing changed.' };
    return (await res.json()) as TargetOutcome;
  } catch {
    return { ok: false, message: 'Something went wrong on this machine, so nothing changed.' };
  }
}
