import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const OUTPUTS_API = `${API_BASE}/outputs`;

export const SERVE_BASE = `${API_BASE}/outputs`;


export interface AutoRunConfig {
  enabled: boolean;
  prompt: string;
  context_paths: Array<{ path: string; type: string }>;
  forced_tools: Array<{ label: string; tools: string[]; iconKey?: string }>;
  mode: string;
  model: string;
}

export interface Output {
  id: string;
  name: string;
  description: string;
  icon: string;
  input_schema: Record<string, any>;
  files: Record<string, string>;
  permission: string;
  auto_run_config?: AutoRunConfig | null;
  thumbnail?: string | null;
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
  async (body: { output_id: string; input_data: Record<string, any> }) => {
    const res = await fetch(`${OUTPUTS_API}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as OutputExecuteResult;
  }
);

export interface AutoRunResult {
  input_data: Record<string, any> | null;
  backend_result: Record<string, any> | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
}

export const autoRunOutput = createAsyncThunk(
  'outputs/autoRun',
  async (body: { prompt: string; input_schema: Record<string, any>; backend_code?: string | null; context_paths?: Array<{ path: string; type: string }>; forced_tools?: string[]; model?: string }) => {
    const res = await fetch(`${OUTPUTS_API}/auto-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as AutoRunResult;
  }
);

export interface AutoRunAgentResult {
  session_id: string;
}

export const autoRunAgentOutput = createAsyncThunk(
  'outputs/autoRunAgent',
  async (body: {
    prompt: string;
    input_schema: Record<string, any>;
    output_id: string;
    model?: string;
    forced_tools?: string[];
    context_paths?: Array<{ path: string; type: string }>;
  }) => {
    const res = await fetch(`${OUTPUTS_API}/auto-run-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Auto-run agent launch failed: ${res.status}`);
    return (await res.json()) as AutoRunAgentResult;
  }
);

export async function cleanupAutoRunAgent(sessionId: string): Promise<void> {
  await fetch(`${OUTPUTS_API}/auto-run-agent/${sessionId}`, { method: 'DELETE' });
}

const outputsSlice = createSlice({
  name: 'outputs',
  initialState,
  reducers: {},
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

export default outputsSlice.reducer;
