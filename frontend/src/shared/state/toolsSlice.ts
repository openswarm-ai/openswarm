import { createSlice } from '@reduxjs/toolkit';
import {
  LIST_TOOLS,
  LIST_BUILTIN_TOOLS,
  CREATE_TOOL,
  UPDATE_TOOL,
  DELETE_TOOL,
  GET_TOOL,
  DISCOVER_TOOL,
  GET_BUILTIN_PERMISSIONS,
  UPDATE_BUILTIN_PERMISSIONS,
  OAUTH_DISCONNECT,
} from '@/shared/backend-bridge/apps/tools';

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  command: string;
  mcp_config: Record<string, any>;
  credentials: Record<string, string>;
  auth_type: string;
  auth_status: string;
  oauth_provider?: string;
  oauth_tokens: Record<string, any>;
  tool_permissions: Record<string, any>;
  connected_account_email?: string;
  enabled?: boolean;
}

export interface BuiltinTool {
  name: string;
  display_name?: string;
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

const initialState: ToolsState = {
  items: {},
  builtinTools: [],
  builtinPermissions: {},
  loading: false,
  loaded: false,
  builtinLoaded: false,
};

const toolsSlice = createSlice({
  name: 'tools',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(LIST_TOOLS.pending, (state) => {
        state.loading = true;
      })
      .addCase(LIST_TOOLS.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.items = {};
        for (const t of action.payload.tools as ToolDefinition[]) state.items[t.id] = t;
      })
      .addCase(LIST_TOOLS.rejected, (state) => {
        state.loading = false;
        state.loaded = true;
      })
      .addCase(LIST_BUILTIN_TOOLS.fulfilled, (state, action) => {
        state.builtinTools = action.payload.tools as BuiltinTool[];
        state.builtinLoaded = true;
      })
      .addCase(CREATE_TOOL.fulfilled, (state, action) => {
        const tool = action.payload.tool as ToolDefinition;
        state.items[tool.id] = tool;
      })
      .addCase(UPDATE_TOOL.fulfilled, (state, action) => {
        const tool = action.payload.tool as ToolDefinition;
        state.items[tool.id] = tool;
      })
      .addCase(DELETE_TOOL.fulfilled, (state, action) => {
        const toolId = action.meta.arg;
        delete state.items[toolId];
      })
      .addCase(GET_TOOL.fulfilled, (state, action) => {
        const tool = action.payload as unknown as ToolDefinition;
        if (tool?.id) state.items[tool.id] = tool;
      })
      .addCase(DISCOVER_TOOL.fulfilled, (state, action) => {
        const tool = action.payload.tool as ToolDefinition;
        state.items[tool.id] = tool;
      })
      .addCase(GET_BUILTIN_PERMISSIONS.fulfilled, (state, action) => {
        state.builtinPermissions = action.payload.permissions;
      })
      .addCase(UPDATE_BUILTIN_PERMISSIONS.fulfilled, (state, action) => {
        state.builtinPermissions = action.payload.permissions;
      })
      .addCase(OAUTH_DISCONNECT.fulfilled, (state, action) => {
        const tool = action.payload.tool as ToolDefinition;
        if (tool?.id) state.items[tool.id] = tool;
      });
  },
});

export default toolsSlice.reducer;
