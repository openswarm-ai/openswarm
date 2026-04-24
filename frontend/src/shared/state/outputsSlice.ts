import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const APP_API = `${API_BASE}/app_builder`;

export const SERVE_BASE = `${API_BASE}/app_builder`;

const DEFAULT_SCHEMA = { type: 'object', properties: {}, required: [] } as Record<string, any>;
const SCHEMA_FILE = 'schema.json';
const META_FILE = 'meta.json';
const SKILL_FILE = 'SKILL.md';


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
  return `${SERVE_BASE}/${workspaceId}/serve/index.html?_d=${encodeURIComponent(encoded)}`;
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

interface AppMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  thumbnail?: string | null;
  created_at: string;
  updated_at: string;
}

function tryParseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function fetchWorkspace(
  appId: string,
): Promise<{ files: Record<string, string>; meta: Record<string, any> | null }> {
  try {
    const res = await fetch(`${APP_API}/app/${appId}`);
    if (!res.ok) return { files: {}, meta: null };
    const data = await res.json();
    return {
      files: (data.files ?? {}) as Record<string, string>,
      meta: (data.meta ?? null) as Record<string, any> | null,
    };
  } catch {
    return { files: {}, meta: null };
  }
}

function hydrateOutput(
  metadata: AppMetadata,
  workspace: { files: Record<string, string>; meta: Record<string, any> | null },
): Output {
  const rawFiles = workspace.files;
  const inputSchema = tryParseJson<Record<string, any>>(rawFiles[SCHEMA_FILE], DEFAULT_SCHEMA);

  const contentFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(rawFiles)) {
    if (path === SCHEMA_FILE || path === META_FILE || path === SKILL_FILE) continue;
    contentFiles[path] = content;
  }

  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    icon: metadata.icon,
    input_schema: inputSchema,
    files: contentFiles,
    permission: 'ask',
    auto_run_config: null,
    thumbnail: metadata.thumbnail ?? null,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
  };
}

function buildSeedFiles(body: {
  files: Record<string, string>;
  input_schema?: Record<string, any>;
  name: string;
  description: string;
}): Record<string, string> {
  const files: Record<string, string> = { ...body.files };
  if (body.input_schema) {
    files[SCHEMA_FILE] = JSON.stringify(body.input_schema, null, 2);
  }
  files[META_FILE] = JSON.stringify({ name: body.name, description: body.description }, null, 2);
  return files;
}

async function writeFile(appId: string, path: string, content: string): Promise<void> {
  try {
    await fetch(`${APP_API}/app/${appId}/file/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch {
    // Ignore failures in best-effort file writes
  }
}

export const fetchOutputs = createAsyncThunk(
  'outputs/fetch',
  async (): Promise<Output[]> => {
    try {
      const res = await fetch(`${APP_API}/list`);
      if (!res.ok) return [];
      const data = await res.json();
      const apps: AppMetadata[] = data.apps ?? [];
      const workspaces = await Promise.all(apps.map((app) => fetchWorkspace(app.id)));
      return apps.map((app, idx) => hydrateOutput(app, workspaces[idx]));
    } catch {
      return [];
    }
  },
  { condition: (_, { getState }) => !(getState() as { outputs: OutputsState }).outputs.loading },
);

export const createOutput = createAsyncThunk(
  'outputs/create',
  async (body: Omit<Output, 'id' | 'created_at' | 'updated_at' | 'permission'>): Promise<Output> => {
    const seedFiles = buildSeedFiles({
      files: body.files,
      input_schema: body.input_schema,
      name: body.name,
      description: body.description,
    });

    const res = await fetch(`${APP_API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: body.name,
        description: body.description,
        icon: body.icon,
        files: seedFiles,
        thumbnail: body.thumbnail ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Create failed: ${res.status}`);
    const data = await res.json();
    const metadata: AppMetadata = data.app;
    const workspace = await fetchWorkspace(metadata.id);
    return hydrateOutput(metadata, workspace);
  },
);

export const updateOutput = createAsyncThunk(
  'outputs/update',
  async ({ id, ...updates }: Partial<Output> & { id: string }): Promise<Output> => {
    const metadataPayload: Record<string, any> = {};
    if (updates.name !== undefined) metadataPayload.name = updates.name;
    if (updates.description !== undefined) metadataPayload.description = updates.description;
    if (updates.icon !== undefined) metadataPayload.icon = updates.icon;
    if (updates.thumbnail !== undefined) metadataPayload.thumbnail = updates.thumbnail;

    let metadata: AppMetadata | null = null;
    if (Object.keys(metadataPayload).length > 0) {
      const res = await fetch(`${APP_API}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadataPayload),
      });
      if (!res.ok) throw new Error(`Update failed: ${res.status}`);
      const data = await res.json();
      metadata = data.app;
    }

    const writes: Promise<void>[] = [];
    if (updates.files) {
      for (const [path, content] of Object.entries(updates.files)) {
        writes.push(writeFile(id, path, content));
      }
    }
    if (updates.input_schema) {
      writes.push(writeFile(id, SCHEMA_FILE, JSON.stringify(updates.input_schema, null, 2)));
    }
    if (updates.name !== undefined || updates.description !== undefined) {
      const nextMeta = {
        name: updates.name ?? metadata?.name ?? '',
        description: updates.description ?? metadata?.description ?? '',
      };
      writes.push(writeFile(id, META_FILE, JSON.stringify(nextMeta, null, 2)));
    }
    await Promise.all(writes);

    if (!metadata) {
      const getRes = await fetch(`${APP_API}/${id}`);
      if (!getRes.ok) throw new Error(`Fetch after update failed: ${getRes.status}`);
      metadata = (await getRes.json()) as AppMetadata;
    }
    const workspace = await fetchWorkspace(id);
    return hydrateOutput(metadata, workspace);
  },
);

export const deleteOutput = createAsyncThunk('outputs/delete', async (id: string) => {
  await fetch(`${APP_API}/${id}`, { method: 'DELETE' });
  return id;
});

export const executeOutput = createAsyncThunk(
  'outputs/execute',
  async (body: { output_id: string; input_data: Record<string, any> }): Promise<OutputExecuteResult> => {
    const res = await fetch(`${APP_API}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: body.output_id }),
    });
    if (!res.ok) {
      return {
        output_id: body.output_id,
        output_name: '',
        frontend_code: '',
        input_data: body.input_data,
        backend_result: null,
        stdout: null,
        stderr: null,
        error: `Execute failed: ${res.status}`,
      };
    }
    const data = await res.json();
    return {
      output_id: data.app_id ?? body.output_id,
      output_name: data.app_name ?? '',
      frontend_code: data.frontend_code ?? '',
      input_data: body.input_data,
      backend_result: data.backend_result ?? null,
      stdout: data.stdout ?? null,
      stderr: data.stderr ?? null,
      error: data.error ?? null,
    };
  },
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
  async (_body: {
    prompt: string;
    input_schema: Record<string, any>;
    backend_code?: string | null;
    context_paths?: Array<{ path: string; type: string }>;
    forced_tools?: string[];
    model?: string;
  }): Promise<AutoRunResult> => {
    // Auto-run is not yet implemented in the app_builder backend. Return an
    // informative error so the UI can surface it gracefully.
    return {
      input_data: null,
      backend_result: null,
      stdout: null,
      stderr: null,
      error: 'Auto-run is not available on this backend yet.',
    };
  },
);

export interface AutoRunAgentResult {
  session_id: string;
}

export const autoRunAgentOutput = createAsyncThunk(
  'outputs/autoRunAgent',
  async (_body: {
    prompt: string;
    input_schema: Record<string, any>;
    output_id: string;
    model?: string;
    forced_tools?: string[];
    context_paths?: Array<{ path: string; type: string }>;
  }): Promise<AutoRunAgentResult> => {
    throw new Error('Auto-run-agent is not available on this backend yet.');
  },
);

export async function cleanupAutoRunAgent(_sessionId: string): Promise<void> {
  // No-op: no auto-run-agent sessions exist on the app_builder backend yet.
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
