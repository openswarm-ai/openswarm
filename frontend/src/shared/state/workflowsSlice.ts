import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const API = `${API_BASE}/workflows`;

export type PermissionKind = 'notify' | 'text' | 'call';

export interface PermissionTier {
  kind: PermissionKind;
  after_minutes: number;
  phone?: string | null;
}

export interface ScheduleConfig {
  enabled: boolean;
  repeat_every: number;
  repeat_unit: 'day' | 'week' | 'month';
  on_days: number[];
  hour: number;
  minute: number;
  timezone: string;
  on_missed: 'skip' | 'run_once' | 'run_all';
  /** End conditions; null on both = forever. Scheduler auto-disables on threshold. */
  ends_at: string | null;
  max_runs: number | null;
  runs_count: number;
}

export interface CostEstimate {
  monthly_usd: number;
  last_run_usd: number;
  fires_per_month: number;
}

export interface ActiveRun {
  workflow_id: string;
  run_id: string;
  title: string;
  started_at: string | null;
}

export interface ActionsConfig {
  prevent_unused: boolean;
  freeze: boolean;
  configured_sets: string[];
}

export interface WorkflowStep {
  id: string;
  text: string;
  /** LLM-generated 3-6 word label shown when the step row is collapsed. The
   *  full `text` is what the agent actually runs; this is just the title. */
  label?: string | null;
}

export interface Workflow {
  id: string;
  title: string;
  description: string;
  icon: string;
  system_prompt: string | null;
  use_synced_prompt: boolean;
  steps: WorkflowStep[];
  actions: ActionsConfig;
  schedule: ScheduleConfig;
  permissions: PermissionTier[];
  source_session_id?: string | null;
  dashboard_id?: string | null;
  model: string;
  mode: string;
  provider: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_run_status: 'success' | 'failure' | 'ran_late' | 'running' | 'skipped' | null;
  last_run_id: string | null;
  next_run_at: string | null;
  cost_cap_usd_monthly: number | null;
  cost_estimate?: CostEstimate;
  /** Sticky session id for the Edit Agent embedded in the workflow card. */
  edit_agent_session_id?: string | null;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  status: 'running' | 'success' | 'failure' | 'ran_late' | 'skipped';
  scheduled_for: string | null;
  started_at: string;
  finished_at: string | null;
  session_id: string | null;
  error: string | null;
  cost_usd: number;
  triggered_by: 'schedule' | 'manual' | 'retry';
  /** Live "what's the agent doing" subtitle while status is 'running'. */
  last_tool_label?: string | null;
  /** Currently-executing 0-based step index while status is 'running';
   *  freezes on the failed step when status flips to 'failure'. */
  active_step_idx?: number | null;
}

/** Transient view-only state per card; position lives in dashboardLayoutSlice.workflowCards. */
export interface OpenCard {
  workflowId: string;
  sourceSessionId?: string | null;
  draft?: Partial<Workflow> | null;
  view:
    | 'preview'
    | 'saved'
    | 'edit'
    | 'history'
    | 'history_detail'
    | 'running'
    | 'completed'
    | 'failed'
    | 'scheduling'
    | 'edit_agent'
    | 'fix_agent';
  editFacet?: 'General' | 'Actions' | 'Schedule';
  historyRunId?: string | null;
  /** The run id currently surfaced by Running/Completed/Failed views. */
  runId?: string | null;
  /** When set, the workflow card is "linked" to a sibling session card via
   *  a labeled arrow chip, and the card footer shifts to Stop Watching /
   *  Stop Viewing / Force Stop. The session id points at the sibling agent. */
  sidecarSessionId?: string | null;
  sidecarKind?: 'watching' | 'viewing-completed' | 'viewing-error' | 'testing' | null;
  /** Per-step expand state for ExpandedView. Stores step ids. */
  expandedStepIds?: string[];
  /** Pre-seed message for the Fix-with-Agent flow so the EditAgent composer
   *  knows which failure context to lead with. Cleared once consumed. */
  fixSeed?: { runId: string; stepIdx: number; stepLabel: string; error: string } | null;
}

interface State {
  items: Record<string, Workflow>;
  runs: Record<string, WorkflowRun[]>;
  openCards: Record<string, OpenCard>;
  loaded: boolean;
  loading: boolean;
  paused: boolean;
  active: ActiveRun[];
  cloudSmsEnabled: boolean;
}

const initialState: State = { items: {}, runs: {}, openCards: {}, loaded: false, loading: false, paused: false, active: [], cloudSmsEnabled: false };

export const fetchWorkflows = createAsyncThunk(
  'workflows/fetch',
  async (dashboardId?: string) => {
    const url = dashboardId ? `${API}/list?dashboard_id=${encodeURIComponent(dashboardId)}` : `${API}/list`;
    const res = await fetch(url);
    const data = await res.json();
    return data.workflows as Workflow[];
  },
  { condition: (_, { getState }) => !(getState() as { workflows: State }).workflows.loading },
);

export const createWorkflow = createAsyncThunk(
  'workflows/create',
  async (body: Partial<Workflow>) => {
    const res = await fetch(`${API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create failed ${res.status}`);
    return (await res.json()) as Workflow;
  },
);

// Optimistic concurrency via If-Match: server 409s on stale writes; rejectWithValue lets FE distinguish.
export const updateWorkflow = createAsyncThunk<
  Workflow,
  { id: string; patch: Partial<Workflow>; ifMatch?: string | null },
  { rejectValue: { kind: 'stale' | 'network' | 'server'; message: string; current_updated_at?: string } }
>(
  'workflows/update',
  async ({ id, patch, ifMatch }, { rejectWithValue }) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ifMatch) headers['If-Match'] = ifMatch;
      const res = await fetch(`${API}/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        const detail = (data && (data.detail || data)) || {};
        return rejectWithValue({
          kind: 'stale',
          message: detail.message || 'This workflow changed elsewhere. Reload and try again.',
          current_updated_at: detail.current_updated_at,
        });
      }
      if (!res.ok) {
        return rejectWithValue({ kind: 'server', message: `Update failed (${res.status}).` });
      }
      return (await res.json()) as Workflow;
    } catch (e) {
      return rejectWithValue({ kind: 'network', message: (e as Error)?.message || 'Network error.' });
    }
  },
);

export const deleteWorkflow = createAsyncThunk('workflows/delete', async (id: string) => {
  await fetch(`${API}/${id}`, { method: 'DELETE' });
  return id;
});

export const runWorkflowNow = createAsyncThunk('workflows/run', async (id: string) => {
  const res = await fetch(`${API}/${id}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`run failed ${res.status}`);
  const data = await res.json();
  return {
    id,
    run_id: (data.run_id || '') as string,
    status: (data.status || null) as string | null,
    error: (data.error || null) as string | null,
  };
});

export const fetchRuns = createAsyncThunk(
  'workflows/runs',
  async (id: string) => {
    const res = await fetch(`${API}/${id}/runs?limit=50`);
    const data = await res.json();
    return { id, runs: data.runs as WorkflowRun[] };
  },
);

export const fetchPausedState = createAsyncThunk('workflows/paused', async () => {
  const res = await fetch(`${API}/paused`);
  const data = await res.json();
  return Boolean(data.paused);
});

export const fetchActiveRuns = createAsyncThunk('workflows/active', async () => {
  const res = await fetch(`${API}/active`);
  const data = await res.json();
  return (data.active || []) as ActiveRun[];
});

export const setPausedAll = createAsyncThunk('workflows/setPaused', async (paused: boolean) => {
  const res = await fetch(`${API}/${paused ? 'pause-all' : 'resume-all'}`, { method: 'POST' });
  if (!res.ok) throw new Error(`pause-all toggle failed ${res.status}`);
  const data = await res.json();
  return Boolean(data.paused);
});

export const ackRun = createAsyncThunk('workflows/ackRun', async (runId: string) => {
  const res = await fetch(`${API}/runs/${encodeURIComponent(runId)}/ack`, { method: 'POST' });
  if (!res.ok) throw new Error(`ack failed ${res.status}`);
  return runId;
});

export const fetchCloudSmsStatus = createAsyncThunk('workflows/cloudSms', async () => {
  try {
    const res = await fetch(`${API}/cloud/sms/status`);
    const data = await res.json();
    return Boolean(data.enabled);
  } catch {
    return false;
  }
});

const slice = createSlice({
  name: 'workflows',
  initialState,
  reducers: {
    openWorkflowCard(state, action: { payload: OpenCard }) {
      state.openCards[action.payload.workflowId] = action.payload;
    },
    updateWorkflowCard(state, action: { payload: { workflowId: string; patch: Partial<OpenCard> } }) {
      const existing = state.openCards[action.payload.workflowId];
      if (existing) state.openCards[action.payload.workflowId] = { ...existing, ...action.payload.patch };
    },
    closeWorkflowCard(state, action: { payload: string }) {
      delete state.openCards[action.payload];
    },
    rekeyOpenCard(state, action: { payload: { oldId: string; newId: string } }) {
      const entry = state.openCards[action.payload.oldId];
      if (!entry) return;
      delete state.openCards[action.payload.oldId];
      state.openCards[action.payload.newId] = { ...entry, workflowId: action.payload.newId };
    },
    upsertRun(state, action: { payload: WorkflowRun }) {
      const r = action.payload;
      const arr = state.runs[r.workflow_id] || [];
      const idx = arr.findIndex((x) => x.id === r.id);
      const prev = idx >= 0 ? arr[idx] : null;
      if (idx >= 0) arr[idx] = r; else arr.unshift(r);
      state.runs[r.workflow_id] = arr.slice(0, 100);
      const wf = state.items[r.workflow_id];
      if (wf) {
        wf.last_run_at = r.finished_at || r.started_at;
        wf.last_run_status = r.status === 'skipped' ? wf.last_run_status : (r.status as Workflow['last_run_status']);
        wf.last_run_id = r.id;
      }
      // Auto-flip the card view on run state transitions so the user sees
      // Running while it streams, Completed on success, Failed on failure.
      // Only nudge from views that the user hasn't actively navigated away
      // from (saved / running). Edit, history, scheduling etc. stay put.
      const card = state.openCards[r.workflow_id];
      if (card) {
        const fromRunnable = card.view === 'saved' || card.view === 'running';
        if (r.status === 'running' && fromRunnable) {
          card.view = 'running';
          card.runId = r.id;
        } else if (prev && prev.status === 'running' && r.status === 'success' && (card.view === 'running' || card.view === 'saved')) {
          card.view = 'completed';
          card.runId = r.id;
        } else if (prev && prev.status === 'running' && r.status === 'failure' && (card.view === 'running' || card.view === 'saved')) {
          card.view = 'failed';
          card.runId = r.id;
        }
      }
    },
    toggleExpandedStep(state, action: { payload: { workflowId: string; stepId: string } }) {
      const card = state.openCards[action.payload.workflowId];
      if (!card) return;
      const arr = card.expandedStepIds || [];
      const has = arr.includes(action.payload.stepId);
      card.expandedStepIds = has ? arr.filter((x) => x !== action.payload.stepId) : [...arr, action.payload.stepId];
    },
    setCardSidecar(state, action: { payload: { workflowId: string; sessionId: string | null; kind: OpenCard['sidecarKind'] } }) {
      const card = state.openCards[action.payload.workflowId];
      if (!card) return;
      card.sidecarSessionId = action.payload.sessionId;
      card.sidecarKind = action.payload.kind;
    },
    clearFixSeed(state, action: { payload: string }) {
      const card = state.openCards[action.payload];
      if (card) card.fixSeed = null;
    },
    // Live workflow changes pushed over WS (e.g. the Edit Agent's
    // add/delete/edit-step tools). Keeps an open card in sync without a
    // full refetch; idempotent, so a window receiving the echo of its own
    // edit just re-sets the same data.
    upsertWorkflow(state, action: { payload: Workflow }) {
      state.items[action.payload.id] = action.payload;
    },
    removeWorkflow(state, action: { payload: string }) {
      delete state.items[action.payload];
      delete state.runs[action.payload];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchWorkflows.pending, (state) => { state.loading = true; })
      .addCase(fetchWorkflows.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const w of action.payload) state.items[w.id] = w;
      })
      .addCase(fetchWorkflows.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(createWorkflow.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(updateWorkflow.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(deleteWorkflow.fulfilled, (state, action) => {
        delete state.items[action.payload];
        delete state.runs[action.payload];
      })
      .addCase(fetchRuns.fulfilled, (state, action) => {
        state.runs[action.payload.id] = action.payload.runs;
      })
      .addCase(fetchPausedState.fulfilled, (state, action) => { state.paused = action.payload; })
      .addCase(setPausedAll.fulfilled, (state, action) => { state.paused = action.payload; })
      .addCase(fetchActiveRuns.fulfilled, (state, action) => { state.active = action.payload; })
      .addCase(fetchCloudSmsStatus.fulfilled, (state, action) => { state.cloudSmsEnabled = action.payload; });
  },
});

export const {
  upsertRun,
  openWorkflowCard,
  updateWorkflowCard,
  closeWorkflowCard,
  rekeyOpenCard,
  toggleExpandedStep,
  setCardSidecar,
  clearFixSeed,
  upsertWorkflow,
  removeWorkflow,
} = slice.actions;
export default slice.reducer;
