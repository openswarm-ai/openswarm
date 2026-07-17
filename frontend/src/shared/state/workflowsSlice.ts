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
  repeat_unit: 'minute' | 'hour' | 'day' | 'week' | 'month';
  on_days: number[];
  hour: number;
  minute: number;
  day_of_month?: number | null;
  /** Monthly schedules fire on the calendar's last day (28-31) when true. */
  last_day_of_month?: boolean;
  timezone: string;
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
  /** Disabled steps stay in the list but the executor skips them. Undefined
   *  (legacy records) is treated as enabled. */
  enabled?: boolean;
}

export interface Workflow {
  id: string;
  title: string;
  description: string;
  icon: string;
  /** User-chosen swatch (hex). Null/undefined falls back to the id-hash color. */
  color?: string | null;
  /** Soft-delete tombstone (ISO). Set = in Trash. */
  deleted_at?: string | null;
  system_prompt: string | null;
  use_synced_prompt: boolean;
  /** Agents may run this workflow via the InvokeWorkflow tool (opt-in per workflow on the Actions page). */
  exposed_as_tool?: boolean;
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
  /** Sticky session id for the embedded scheduling agent (cadence -> gated tool call). */
  schedule_agent_session_id?: string | null;
  /** Pending Edit-Agent draft of the steps; present only while editing. */
  draft_steps?: WorkflowStep[] | null;
  /** True when a draft is staged (server-computed convenience flag). */
  has_draft?: boolean;
  /** Most recent Test Agent session for this workflow. */
  last_test_session_id?: string | null;
  /** Tool permissions the user answered once and we reuse on later runs so an
   *  unattended scheduled fire doesn't stall on a prompt. tool name -> answer. */
  remembered_approvals?: Record<string, 'allow' | 'deny'>;
  step_tool_usage?: Record<string, Record<string, boolean>>;
  /** Tool names observed in the source chat when this workflow was generated. */
  source_tools?: string[];
  /** False once the user explicitly renames the workflow; backend may auto-rename while true. */
  auto_named?: boolean;
  /** True while a brand-new "+ New" workflow is still being built and hasn't been saved; hub hides these. */
  unsaved?: boolean;
  /** Signature of the steps last validated by a test run (or seeded at chat
   *  conversion). Compared against the current steps to decide whether to warn
   *  before scheduling. See scheduleUtils.needsScheduleTestWarning. */
  tested_signature?: string | null;
  /** Suggested cadence from a SuggestConvertToWorkflow tool call (e.g. "every weekday at 9am").
   *  Used to seed the scheduling agent's prompt. Transient draft field only. */
  suggested_cadence?: string;
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
  /** True while the user has paused the in-flight agent turn (chat-style
   *  stop/resume). Drives the running card's Pause/Resume button. */
  paused?: boolean;
}

export type WorkflowRunControlAction = 'pause' | 'resume' | 'stop';

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
  /** One-shot "Schedule this workflow?" prompt shown right after a convert.
   *  Transient: lives only on the just-created card, never on hub-opened ones. */
  showScheduleNudge?: boolean;
  /** Pre-seed message for the Fix-with-Agent flow so the EditAgent composer
   *  knows which failure context to lead with. Cleared once consumed. */
  fixSeed?: { runId: string; stepIdx: number; stepLabel: string; error: string } | null;
  /** True while the preview-time aux naming call is in flight; drives the
   *  header's subtle pulse on a just-converted draft. */
  metaLoading?: boolean;
  /** True once preview-time naming filled a real title, so save trusts the
   *  draft's metadata instead of regenerating it server-side. */
  metaGenerated?: boolean;
}

export interface RunningToast {
  workflowId: string;
  runId: string;
  workflowTitle: string;
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
  allRuns: WorkflowRun[];
  allRunsLoading: boolean;
  runningToast: RunningToast | null;
  runControlPending: Record<string, WorkflowRunControlAction>;
  deleted: Workflow[];
  deletedLoading: boolean;
}

const initialState: State = { items: {}, runs: {}, openCards: {}, loaded: false, loading: false, paused: false, active: [], cloudSmsEnabled: false, allRuns: [], allRunsLoading: false, runningToast: null, runControlPending: {}, deleted: [], deletedLoading: false };

function mergeRunIntoState(state: State, r: WorkflowRun) {
  const arr = state.runs[r.workflow_id] || [];
  const idx = arr.findIndex((x) => x.id === r.id);
  const prev = idx >= 0 ? arr[idx] : null;
  if (idx >= 0) arr[idx] = r; else arr.unshift(r);
  state.runs[r.workflow_id] = arr.slice(0, 100);
  // Keep the cross-workflow log (Scheduled tasks history tab) live without a refetch.
  const aIdx = state.allRuns.findIndex((x) => x.id === r.id);
  if (aIdx >= 0) state.allRuns[aIdx] = r; else state.allRuns.unshift(r);
  state.allRuns.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  state.allRuns = state.allRuns.slice(0, 200);
  const pending = state.runControlPending[r.id];
  if (
    (pending === 'pause' && r.paused) ||
    (pending === 'resume' && !r.paused) ||
    (pending === 'stop' && r.status !== 'running')
  ) {
    delete state.runControlPending[r.id];
  }
  const wf = state.items[r.workflow_id];
  if (wf) {
    wf.last_run_at = r.finished_at || r.started_at;
    wf.last_run_status = r.status === 'skipped' ? wf.last_run_status : (r.status as Workflow['last_run_status']);
    wf.last_run_id = r.id;
  }
  // Keep the live "Ongoing runs" list in sync off the WS stream: a run that's no longer running drops out of `active`, a freshly-running one joins. Without this, `active` only refreshed on the one-shot mount fetch, so finished runs lingered as "Working…" while the monitor already showed them done.
  const activeIdx = state.active.findIndex((a) => a.run_id === r.id);
  if (r.status === 'running') {
    const entry: ActiveRun = { workflow_id: r.workflow_id, run_id: r.id, title: wf?.title || '', started_at: r.started_at };
    if (activeIdx >= 0) state.active[activeIdx] = entry; else state.active.unshift(entry);
  } else if (activeIdx >= 0) {
    state.active.splice(activeIdx, 1);
  }
  // Auto-flip the card view on run state transitions so the user sees Running while it streams, Completed on success, Failed on failure. Only nudge from views that the user hasn't actively navigated away from (saved / running). Edit, history, scheduling etc. stay put.
  const card = state.openCards[r.workflow_id];
  // A scheduled run flipping into 'running' fired unattended, so nudge the user with a clickable toast. Only on the into-running edge (not every tool-label/step bump), and only for schedule (manual runs they kicked off themselves don't need a "surprise, it's running" popup).
  if (r.status === 'running' && r.triggered_by === 'schedule' && (!prev || prev.status !== 'running')) {
    state.runningToast = {
      workflowId: r.workflow_id,
      runId: r.id,
      workflowTitle: state.items[r.workflow_id]?.title || 'Workflow',
    };
  }
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
    // A run that finishes while the user is watching it live becomes a "viewing" link so the sibling chat stays open with Stop Viewing, not a stale "watching" arrow pointing at a finished run.
    if (card.sidecarSessionId && card.sidecarKind === 'watching' && prev && prev.status === 'running') {
      if (r.status === 'failure') card.sidecarKind = 'viewing-error';
      else if (r.status === 'success' || r.status === 'ran_late') card.sidecarKind = 'viewing-completed';
    }
  }
}

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
  async (body: Partial<Workflow> & { metadata_generated?: boolean }) => {
    const res = await fetch(`${API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create failed ${res.status}`);
    return (await res.json()) as Workflow;
  },
);

export interface GeneratedMetadata {
  title: string;
  description: string;
  step_labels: string[];
}

export const generateWorkflowMetadata = createAsyncThunk(
  'workflows/generateMetadata',
  async (arg: { steps: Array<{ id: string; text: string }>; model?: string }) => {
    const res = await fetch(`${API}/generate-metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arg),
    });
    if (!res.ok) throw new Error(`metadata failed ${res.status}`);
    return (await res.json()) as GeneratedMetadata;
  },
);

// Merge preview-time generated metadata into a draft card, filling only the fields the user hasn't typed into so a rename mid-flight survives.
export const applyGeneratedMetadata = createAsyncThunk(
  'workflows/applyGeneratedMetadata',
  async (arg: { workflowId: string; meta: GeneratedMetadata }, { getState, dispatch }) => {
    const state = getState() as { workflows: State };
    const card = state.workflows.openCards[arg.workflowId];
    if (!card) return;
    const draft = (card.draft || {}) as Partial<Workflow>;
    const { meta } = arg;
    const steps = draft.steps || [];
    const nextDraft: Partial<Workflow> = { ...draft };
    let changed = false;
    if (meta.step_labels && meta.step_labels.length === steps.length) {
      nextDraft.steps = steps.map((s, i) => (meta.step_labels[i] ? { ...s, label: meta.step_labels[i] } : s));
      changed = true;
    }
    const hasTitle = Boolean(meta.title && meta.title.trim());
    if (hasTitle && !(draft.title || '').trim()) { nextDraft.title = meta.title; changed = true; }
    if (meta.description && meta.description.trim() && !(draft.description || '').trim()) {
      nextDraft.description = meta.description;
      changed = true;
    }
    const patch: Partial<OpenCard> = { metaLoading: false, metaGenerated: hasTitle };
    if (changed) patch.draft = nextDraft;
    dispatch(updateWorkflowCard({ workflowId: arg.workflowId, patch }));
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

type CommitDraftArg = string | { id: string; model?: string; keep_session?: boolean };

export const commitDraft = createAsyncThunk('workflows/commitDraft', async (arg: CommitDraftArg) => {
  const id = typeof arg === 'string' ? arg : arg.id;
  // Save-gated: the model the user settled on in the Edit Agent picker is applied to the workflow's run model here (Discard never reaches this path).
  const model = typeof arg === 'string' ? undefined : arg.model;
  // keep_session: the build flow auto-commits steps but must keep the chat open.
  const keepSession = typeof arg === 'string' ? undefined : arg.keep_session;
  const body: Record<string, unknown> = {};
  if (model) body.model = model;
  if (keepSession) body.keep_session = true;
  const res = await fetch(`${API}/${id}/draft/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`commit failed ${res.status}`);
  return (await res.json()) as Workflow;
});

export const discardDraft = createAsyncThunk('workflows/discardDraft', async (id: string) => {
  const res = await fetch(`${API}/${id}/draft/discard`, { method: 'POST' });
  if (!res.ok) throw new Error(`discard failed ${res.status}`);
  return (await res.json()) as Workflow;
});

export const deleteWorkflow = createAsyncThunk('workflows/delete', async (id: string) => {
  await fetch(`${API}/${id}`, { method: 'DELETE' });
  return id;
});

export const fetchDeletedWorkflows = createAsyncThunk('workflows/fetchDeleted', async (dashboardId?: string) => {
  const url = dashboardId ? `${API}/deleted?dashboard_id=${encodeURIComponent(dashboardId)}` : `${API}/deleted`;
  const res = await fetch(url);
  const data = await res.json();
  return data.workflows as Workflow[];
});

export const restoreWorkflow = createAsyncThunk('workflows/restore', async (id: string) => {
  const res = await fetch(`${API}/${id}/restore`, { method: 'POST' });
  if (!res.ok) throw new Error(`restore failed ${res.status}`);
  return (await res.json()) as Workflow;
});

export const purgeWorkflow = createAsyncThunk('workflows/purge', async (id: string) => {
  const res = await fetch(`${API}/${id}/purge`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`purge failed ${res.status}`);
  return id;
});

type RunWorkflowNowArg = string | { id: string; signature?: string | null };

export const runWorkflowNow = createAsyncThunk('workflows/run', async (arg: RunWorkflowNowArg) => {
  const id = typeof arg === 'string' ? arg : arg.id;
  const signature = typeof arg === 'string' ? null : arg.signature;
  const res = await fetch(`${API}/${id}/run`, {
    method: 'POST',
    ...(signature ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature }),
    } : {}),
  });
  if (!res.ok) throw new Error(`run failed ${res.status}`);
  const data = await res.json();
  return {
    id,
    run_id: (data.run_id || '') as string,
    status: (data.status || null) as string | null,
    error: (data.error || null) as string | null,
  };
});

export const controlWorkflowRun = createAsyncThunk(
  'workflows/controlRun',
  async ({ runId, action }: { runId: string; action: WorkflowRunControlAction }) => {
    const res = await fetch(`${API}/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`${action} failed ${res.status}`);
    const data = await res.json();
    return {
      runId,
      action,
      run: (data.run || null) as WorkflowRun | null,
    };
  },
);

export const fetchRuns = createAsyncThunk(
  'workflows/runs',
  async (id: string) => {
    const res = await fetch(`${API}/${id}/runs?limit=50`);
    const data = await res.json();
    return { id, runs: data.runs as WorkflowRun[] };
  },
);

export const fetchAllRuns = createAsyncThunk(
  'workflows/allRuns',
  async (limit: number = 200) => {
    const res = await fetch(`${API}/runs/all?limit=${limit}`);
    const data = await res.json();
    return data.runs as WorkflowRun[];
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
      mergeRunIntoState(state, action.payload);
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
    // Live workflow changes pushed over WS (e.g. the Edit Agent's add/delete/edit-step tools). Keeps an open card in sync without a full refetch; idempotent, so a window receiving the echo of its own edit just re-sets the same data.
    upsertWorkflow(state, action: { payload: Workflow }) {
      state.items[action.payload.id] = action.payload;
    },
    removeWorkflow(state, action: { payload: string }) {
      delete state.items[action.payload];
      delete state.runs[action.payload];
      state.allRuns = state.allRuns.filter((r) => r.workflow_id !== action.payload);
    },
    dismissRunningToast(state) {
      state.runningToast = null;
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
      // Optimistic: reflect the patch in the store immediately so store-driven UI (the schedule test-first banner, status, etc.) updates the instant the user edits, not after the PATCH round-trips (which awaits an aux relabel LLM call server-side). fulfilled overwrites with server truth; a 409 stale triggers a refetch in useWorkflowPatch.
      .addCase(updateWorkflow.pending, (state, action) => {
        const { id, patch } = action.meta.arg;
        const cur = state.items[id];
        if (cur) state.items[id] = { ...cur, ...patch };
      })
      .addCase(updateWorkflow.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(commitDraft.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(discardDraft.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(deleteWorkflow.fulfilled, (state, action) => {
        delete state.items[action.payload];
        delete state.runs[action.payload];
        state.allRuns = state.allRuns.filter((r) => r.workflow_id !== action.payload);
      })
      .addCase(runWorkflowNow.fulfilled, (state, action) => {
        // Enter the running view the moment the run kicks off, off the run_id the REST call returns. Don't wait for the workflow:run WS event: if it's missed or races the view, the Stop/Pause header never shows.
        const { id, run_id, status } = action.payload;
        const card = state.openCards[id];
        if (!card || !run_id || status !== 'running') return;
        if (['saved', 'running', 'completed', 'failed', 'history', 'history_detail'].includes(card.view)) {
          card.view = 'running';
          card.runId = run_id;
        }
      })
      .addCase(controlWorkflowRun.pending, (state, action) => {
        state.runControlPending[action.meta.arg.runId] = action.meta.arg.action;
      })
      .addCase(controlWorkflowRun.fulfilled, (state, action) => {
        if (action.payload.run) {
          mergeRunIntoState(state, action.payload.run);
        }
        if (action.payload.action !== 'stop') {
          delete state.runControlPending[action.payload.runId];
        } else if (action.payload.run && action.payload.run.status !== 'running') {
          delete state.runControlPending[action.payload.runId];
        }
      })
      .addCase(controlWorkflowRun.rejected, (state, action) => {
        delete state.runControlPending[action.meta.arg.runId];
      })
      .addCase(fetchRuns.fulfilled, (state, action) => {
        state.runs[action.payload.id] = action.payload.runs;
        for (const r of action.payload.runs) {
          const pending = state.runControlPending[r.id];
          if (
            (pending === 'pause' && r.paused) ||
            (pending === 'resume' && !r.paused) ||
            (pending === 'stop' && r.status !== 'running')
          ) {
            delete state.runControlPending[r.id];
          }
        }
      })
      .addCase(fetchAllRuns.pending, (state) => { state.allRunsLoading = true; })
      .addCase(fetchAllRuns.fulfilled, (state, action) => {
        state.allRunsLoading = false;
        state.allRuns = action.payload;
      })
      .addCase(fetchAllRuns.rejected, (state) => { state.allRunsLoading = false; })
      .addCase(fetchDeletedWorkflows.pending, (state) => { state.deletedLoading = true; })
      .addCase(fetchDeletedWorkflows.fulfilled, (state, action) => { state.deletedLoading = false; state.deleted = action.payload; })
      .addCase(fetchDeletedWorkflows.rejected, (state) => { state.deletedLoading = false; })
      .addCase(restoreWorkflow.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
        state.deleted = state.deleted.filter((w) => w.id !== action.payload.id);
      })
      .addCase(purgeWorkflow.fulfilled, (state, action) => {
        state.deleted = state.deleted.filter((w) => w.id !== action.payload);
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
  dismissRunningToast,
} = slice.actions;
export default slice.reducer;
