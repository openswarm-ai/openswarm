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
}

export interface ActionsConfig {
  prevent_unused: boolean;
  freeze: boolean;
  configured_sets: string[];
}

export interface WorkflowStep {
  id: string;
  text: string;
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
  last_run_status: 'success' | 'failure' | 'ran_late' | 'running' | null;
  last_run_id: string | null;
  next_run_at: string | null;
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
}

// Position lives in dashboardLayoutSlice.workflowCards now. This entry
// only carries transient view state — which tab is open, draft contents
// for unsaved cards, the currently inspected history run, etc.
export interface OpenCard {
  workflowId: string;
  sourceSessionId?: string | null;
  draft?: Partial<Workflow> | null;
  view: 'preview' | 'saved' | 'edit' | 'history' | 'history_detail';
  editFacet?: 'General' | 'Actions' | 'Schedule';
  historyRunId?: string | null;
}

interface State {
  items: Record<string, Workflow>;
  runs: Record<string, WorkflowRun[]>;
  openCards: Record<string, OpenCard>;
  loaded: boolean;
  loading: boolean;
}

const initialState: State = { items: {}, runs: {}, openCards: {}, loaded: false, loading: false };

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

export const updateWorkflow = createAsyncThunk(
  'workflows/update',
  async ({ id, patch }: { id: string; patch: Partial<Workflow> }) => {
    const res = await fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`update failed ${res.status}`);
    return (await res.json()) as Workflow;
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
  return { id, run_id: data.run_id as string };
});

export const fetchRuns = createAsyncThunk(
  'workflows/runs',
  async (id: string) => {
    const res = await fetch(`${API}/${id}/runs?limit=50`);
    const data = await res.json();
    return { id, runs: data.runs as WorkflowRun[] };
  },
);

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
      if (idx >= 0) arr[idx] = r; else arr.unshift(r);
      state.runs[r.workflow_id] = arr.slice(0, 100);
      const wf = state.items[r.workflow_id];
      if (wf) {
        wf.last_run_at = r.finished_at || r.started_at;
        wf.last_run_status = r.status === 'skipped' ? wf.last_run_status : (r.status as Workflow['last_run_status']);
        wf.last_run_id = r.id;
      }
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
      });
  },
});

export const { upsertRun, openWorkflowCard, updateWorkflowCard, closeWorkflowCard, rekeyOpenCard } = slice.actions;
export default slice.reducer;
