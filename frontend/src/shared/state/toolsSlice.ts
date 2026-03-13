import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/tools`;

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  command: string;
  mcp_config: Record<string, any>;
  credentials: Record<string, string>;
  auth_type: string;
  auth_status: string;
  oauth_tokens: Record<string, any>;
  tool_permissions: Record<string, any>;
  connected_account_email?: string;
  enabled?: boolean;
}

export interface BuiltinTool {
  name: string;
  description: string;
  category: string;
  deferred: boolean;
}

interface ToolsState {
  items: Record<string, ToolDefinition>;
  builtinTools: BuiltinTool[];
  builtinPermissions: Record<string, string>;
  loading: boolean;
  loaded: boolean;
  builtinLoaded: boolean;
}

const initialState: ToolsState = { items: {}, builtinTools: [], builtinPermissions: {}, loading: false, loaded: false, builtinLoaded: false };

export const fetchTools = createAsyncThunk(
  'tools/fetch',
  async () => {
    const res = await fetch(`${API_BASE}/list`);
    const data = await res.json();
    return data.tools as ToolDefinition[];
  },
  { condition: (_, { getState }) => !(getState() as { tools: ToolsState }).tools.loading },
);

export const fetchBuiltinTools = createAsyncThunk(
  'tools/fetchBuiltin',
  async () => {
    const res = await fetch(`${API_BASE}/builtin`);
    const data = await res.json();
    return data.tools as BuiltinTool[];
  },
  { condition: (_, { getState }) => !(getState() as { tools: ToolsState }).tools.builtinLoaded },
);

export const createTool = createAsyncThunk(
  'tools/create',
  async (body: Partial<Omit<ToolDefinition, 'id'>> & { name: string }) => {
    const res = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.tool as ToolDefinition;
  }
);

export const updateTool = createAsyncThunk(
  'tools/update',
  async ({ id, ...updates }: Partial<ToolDefinition> & { id: string }) => {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    return data.tool as ToolDefinition;
  }
);

export const deleteTool = createAsyncThunk('tools/delete', async (id: string) => {
  await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  return id;
});

export const startOAuth = createAsyncThunk(
  'tools/startOAuth',
  async (toolId: string) => {
    const res = await fetch(`${API_BASE}/${toolId}/oauth/start`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to start OAuth');
    const data = await res.json();
    return data as { auth_url: string };
  }
);

export const fetchToolStatus = createAsyncThunk(
  'tools/fetchStatus',
  async (toolId: string) => {
    const res = await fetch(`${API_BASE}/${toolId}`);
    const data = await res.json();
    return data as ToolDefinition;
  }
);

export const discoverTools = createAsyncThunk(
  'tools/discover',
  async (toolId: string) => {
    const res = await fetch(`${API_BASE}/${toolId}/discover`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Discovery failed' }));
      throw new Error(err.detail || 'Discovery failed');
    }
    const data = await res.json();
    return data.tool as ToolDefinition;
  }
);

export const fetchBuiltinPermissions = createAsyncThunk('tools/fetchBuiltinPermissions', async () => {
  const res = await fetch(`${API_BASE}/builtin/permissions`);
  const data = await res.json();
  return data.permissions as Record<string, string>;
});

export const updateBuiltinPermissions = createAsyncThunk(
  'tools/updateBuiltinPermissions',
  async (permissions: Record<string, string>) => {
    const res = await fetch(`${API_BASE}/builtin/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions }),
    });
    const data = await res.json();
    return data.permissions as Record<string, string>;
  }
);

const toolsSlice = createSlice({
  name: 'tools',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchTools.pending, (state) => { state.loading = true; })
      .addCase(fetchTools.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const t of action.payload) state.items[t.id] = t;
      })
      .addCase(fetchTools.rejected, (state) => { state.loading = false; state.loaded = true; })
      .addCase(fetchBuiltinTools.fulfilled, (state, action) => { state.builtinTools = action.payload; state.builtinLoaded = true; })
      .addCase(createTool.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(updateTool.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(deleteTool.fulfilled, (state, action) => { delete state.items[action.payload]; })
      .addCase(fetchToolStatus.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(discoverTools.fulfilled, (state, action) => { state.items[action.payload.id] = action.payload; })
      .addCase(fetchBuiltinPermissions.fulfilled, (state, action) => { state.builtinPermissions = action.payload; })
      .addCase(updateBuiltinPermissions.fulfilled, (state, action) => { state.builtinPermissions = action.payload; });
  },
});

export default toolsSlice.reducer;
