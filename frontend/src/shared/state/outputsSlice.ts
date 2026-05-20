import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const OUTPUTS_API = `${API_BASE}/outputs`;

export const SERVE_BASE = `${API_BASE}/outputs`;


export interface Output {
  id: string;
  name: string;
  description: string;
  icon: string;
  input_schema: Record<string, any>;
  files: Record<string, string>;
  permission: string;
  thumbnail?: string | null;
  /** Linkage so reopening App Builder reattaches to the in-progress session and workspace. */
  session_id?: string | null;
  workspace_id?: string | null;
  created_at: string;
  updated_at: string;
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

export function buildWorkspaceServeUrl(
  workspaceId: string,
  inputData: Record<string, any> = {},
  backendResult: Record<string, any> | null = null,
): string {
  const dataPayload = JSON.stringify({ i: inputData, r: backendResult });
  const encoded = btoa(unescape(encodeURIComponent(dataPayload)));
  return `${SERVE_BASE}/workspace/${workspaceId}/serve/index.html?_d=${encodeURIComponent(encoded)}`;
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
}

const initialState: OutputsState = { items: {}, loading: false, loaded: false };

export const fetchOutputs = createAsyncThunk(
  'outputs/fetch',
  async () => {
    const res = await fetch(`${OUTPUTS_API}/list`);
    const data = await res.json();
    return data.outputs as Output[];
  },
  { condition: (_, { getState }) => !(getState() as { outputs: OutputsState }).outputs.loading },
);

export const createOutput = createAsyncThunk(
  'outputs/create',
  async (body: Omit<Output, 'id' | 'created_at' | 'updated_at' | 'permission'>) => {
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
      .addCase(deleteOutput.fulfilled, (state, action) => { delete state.items[action.payload]; });
  },
});

export const { upsertOutput } = outputsSlice.actions;
export default outputsSlice.reducer;
