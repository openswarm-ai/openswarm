import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const OUTPUTS_API = `${API_BASE}/outputs`;
const VERSIONS_API = `${API_BASE}/output_versions`;

export const SERVE_BASE = `${API_BASE}/outputs`;


export interface Output {
  id: string;
  name: string;
  description: string;
  icon: string;
  input_schema: Record<string, any>;
  files: Record<string, string>;
  thumbnail?: string | null;
  /** Bumped only on a real screenshot save; sidebar/grids sort by this so opening an app doesn't reorder it. */
  preview_updated_at?: string | null;
  /** Linkage so reopening App Builder reattaches to the in-progress session and workspace. */
  session_id?: string | null;
  workspace_id?: string | null;
  /** Backend-resolved absolute on-disk folder for this app; API-only, empty when no workspace_id. */
  workspace_path?: string;
  created_at: string;
  updated_at: string;
  /** App publishing to {slug}.openswarm.host. Server-managed; mirrored here after a publish/unpublish. */
  published_slug?: string | null;
  published_url?: string | null;
  publish_status?: 'publishing' | 'published' | 'error' | null;
}

/** One saved point in an app's history. The heavy snapshot lives in a zip on
 * the backend; this is the lightweight row the History timeline renders. */
export interface OutputVersion {
  id: string;
  created_at: string;
  label: string;
  /** auto: saved after a builder change. manual: user saved it. pre_restore: the
   * automatic backup taken right before a restore, so going back is undoable. */
  source: 'auto' | 'manual' | 'pre_restore';
  parent_id?: string | null;
  thumbnail?: string | null;
}

export interface PublishStatePatch {
  id: string;
  published_slug?: string | null;
  published_url?: string | null;
  publish_status?: Output['publish_status'];
}

export function getFrontendCode(output: Output): string {
  return output.files?.['index.html'] ?? '';
}

export function getBackendCode(output: Output): string | null {
  return output.files?.['backend.py'] ?? null;
}

export function buildServeUrl(
  outputId: string,
  inputData: Record<string, any> = {},
  backendResult: Record<string, any> | null = null,
): string {
  const dataPayload = JSON.stringify({ i: inputData, r: backendResult });
  const encoded = btoa(unescape(encodeURIComponent(dataPayload)));
  return `${SERVE_BASE}/${outputId}/serve/index.html?_d=${encodeURIComponent(encoded)}`;
}

export interface OutputExecuteResult {
  output_id: string;
  output_name: string;
  frontend_code: string;
  input_data: Record<string, any>;
  backend_result: Record<string, any> | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  /** Set when AST validator flagged risky code without force=true; resubmit with force to bypass. */
  warnings?: string[] | null;
  code_preview?: string | null;
}

interface OutputsState {
  items: Record<string, Output>;
  loading: boolean;
  loaded: boolean;
  // Bumped per app whenever a version is captured (auto after a build, or manual). Lets an already-open History panel know to refetch without polling or timing guesses: the editor and the panel are siblings, so this is their only shared signal.
  captureSignal: Record<string, number>;
}

const initialState: OutputsState = { items: {}, loading: false, loaded: false, captureSignal: {} };

export const fetchOutputs = createAsyncThunk(
  'outputs/fetch',
  async () => {
    const res = await fetch(`${OUTPUTS_API}/list`);
    if (!res.ok) throw new Error(`Outputs list failed: ${res.status}`);
    const data = await res.json();
    return data.outputs as Output[];
  },
  { condition: (_, { getState }) => !(getState() as { outputs: OutputsState }).outputs.loading },
);

export const createOutput = createAsyncThunk(
  'outputs/create',
  async (body: Omit<Output, 'id' | 'created_at' | 'updated_at'>) => {
    const res = await fetch(`${OUTPUTS_API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Create failed: ${res.status}`);
    const data = await res.json();
    return data.output as Output;
  }
);

export const updateOutput = createAsyncThunk(
  'outputs/update',
  async ({ id, ...updates }: Partial<Output> & { id: string }) => {
    const res = await fetch(`${OUTPUTS_API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Update failed: ${res.status}`);
    const data = await res.json();
    return data.output as Output;
  }
);

export const deleteOutput = createAsyncThunk('outputs/delete', async (id: string) => {
  await fetch(`${OUTPUTS_API}/${id}`, { method: 'DELETE' });
  return id;
});

export const executeOutput = createAsyncThunk(
  'outputs/execute',
  // `force` opts past the AST warnings gate (Run Anyway in the dialog).
  async (body: { output_id: string; input_data: Record<string, any>; force?: boolean }) => {
    const res = await fetch(`${OUTPUTS_API}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as OutputExecuteResult;
  }
);

export const fetchOutputVersions = createAsyncThunk(
  'outputs/versions/fetch',
  async (outputId: string) => {
    const res = await fetch(`${VERSIONS_API}/${outputId}`);
    if (!res.ok) throw new Error(`Versions fetch failed: ${res.status}`);
    const data = await res.json();
    return data.versions as OutputVersion[];
  }
);

export const captureOutputVersion = createAsyncThunk(
  'outputs/versions/capture',
  async ({ id, source, label, thumbnail }: {
    id: string; source: 'auto' | 'manual'; label?: string; thumbnail?: string | null;
  }) => {
    const res = await fetch(`${VERSIONS_API}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, label: label ?? '', thumbnail: thumbnail ?? null }),
    });
    if (!res.ok) throw new Error(`Capture failed: ${res.status}`);
    return (await res.json()).version as OutputVersion;
  }
);

export const restoreOutputVersion = createAsyncThunk(
  'outputs/versions/restore',
  async ({ id, versionId }: { id: string; versionId: string }) => {
    const res = await fetch(`${VERSIONS_API}/${id}/${versionId}/restore`, { method: 'POST' });
    if (!res.ok) {
      // Surface the backend's friendly reason (e.g. the 409 "still being edited").
      let detail = 'Could not restore that version.';
      try { detail = (await res.json()).detail || detail; } catch { /* keep default */ }
      throw new Error(detail);
    }
    return (await res.json()).output as Output;
  }
);

export const branchOutputVersion = createAsyncThunk(
  'outputs/versions/branch',
  async ({ id, versionId }: { id: string; versionId: string }) => {
    const res = await fetch(`${VERSIONS_API}/${id}/${versionId}/branch`, { method: 'POST' });
    if (!res.ok) throw new Error(`Branch failed: ${res.status}`);
    return (await res.json()).new_output_id as string;
  }
);

const outputsSlice = createSlice({
  name: 'outputs',
  initialState,
  reducers: {
    /** Upsert an Output row from a server-pushed WS event (canvas-launched
     * App Builder seeds the row on launch; meta-sync renames it at session
     * end). Merges over existing fields so a row that already has agent-
     * generated content doesn't lose anything from a partial server push.
     */
    upsertOutput(state, action: { payload: Output; type: string }) {
      const incoming = action.payload;
      const existing = state.items[incoming.id];
      state.items[incoming.id] = existing ? { ...existing, ...incoming } : incoming;
    },
    /** Reflect a publish/unpublish result onto an existing Output without a refetch. */
    setOutputPublishState(state, action: { payload: PublishStatePatch; type: string }) {
      const o = state.items[action.payload.id];
      if (!o) return;
      if ('published_slug' in action.payload) o.published_slug = action.payload.published_slug ?? null;
      if ('published_url' in action.payload) o.published_url = action.payload.published_url ?? null;
      if ('publish_status' in action.payload) o.publish_status = action.payload.publish_status ?? null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchOutputs.pending, (state) => { state.loading = true; })
      .addCase(fetchOutputs.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const o of action.payload) state.items[o.id] = o;
      })
      .addCase(fetchOutputs.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(createOutput.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(updateOutput.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(restoreOutputVersion.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(captureOutputVersion.fulfilled, (state, action) => {
        const id = action.meta.arg.id;
        state.captureSignal[id] = (state.captureSignal[id] ?? 0) + 1;
      })
      .addCase(deleteOutput.fulfilled, (state, action) => { delete state.items[action.payload]; });
  },
});

export const { upsertOutput, setOutputPublishState } = outputsSlice.actions;
export default outputsSlice.reducer;
