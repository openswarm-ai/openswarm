import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const TOOLS_API: string = `${API_BASE}/tools`;

// ---------------------------------------------------------------------------
// Builtin tools
// ---------------------------------------------------------------------------


const list_builtin_tools_endpoint: string = `${TOOLS_API}/builtin`;
async function list_builtin_tools_function(): Promise<{ tools: Record<string, unknown>[] }> {
  const res = await fetch(list_builtin_tools_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { tools: Record<string, unknown>[] };
}
export const LIST_BUILTIN_TOOLS = createAsyncThunk(
  list_builtin_tools_endpoint,
  list_builtin_tools_function,
);


const get_builtin_permissions_endpoint: string = `${TOOLS_API}/get_builtin_permissions`;
async function get_builtin_permissions_function(): Promise<{ permissions: Record<string, string> }> {
  const res = await fetch(get_builtin_permissions_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { permissions: Record<string, string> };
}
export const GET_BUILTIN_PERMISSIONS = createAsyncThunk(
  get_builtin_permissions_endpoint,
  get_builtin_permissions_function,
);


const update_builtin_permissions_endpoint: string = `${TOOLS_API}/update_builtin_permissions`;
async function update_builtin_permissions_function(permissions: Record<string, string>): Promise<{ permissions: Record<string, string> }> {
  const res = await fetch(update_builtin_permissions_endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions }),
  });
  const data = await res.json();
  return data as { permissions: Record<string, string> };
}
export const UPDATE_BUILTIN_PERMISSIONS = createAsyncThunk(
  update_builtin_permissions_endpoint,
  update_builtin_permissions_function,
);


// ---------------------------------------------------------------------------
// User-installed tool CRUD
// ---------------------------------------------------------------------------


const list_tools_endpoint: string = `${TOOLS_API}/list`;
async function list_tools_function(): Promise<{ tools: Record<string, unknown>[] }> {
  const res = await fetch(list_tools_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { tools: Record<string, unknown>[] };
}
export const LIST_TOOLS = createAsyncThunk(
  list_tools_endpoint,
  list_tools_function,
);


const create_tool_endpoint: string = `${TOOLS_API}/create`;
async function create_tool_function(body: {
  name: string;
  description?: string;
  command?: string;
  mcp_config?: Record<string, unknown>;
  credentials?: Record<string, string>;
  auth_type?: string;
  auth_status?: string;
  oauth_provider?: string | null;
}): Promise<{ ok: boolean; tool: Record<string, unknown> }> {
  const res = await fetch(create_tool_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { ok: boolean; tool: Record<string, unknown> };
}
export const CREATE_TOOL = createAsyncThunk(
  create_tool_endpoint,
  create_tool_function,
);


const get_tool_endpoint: string = `${TOOLS_API}/get`;
async function get_tool_function(toolId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${TOOLS_API}/${toolId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const GET_TOOL = createAsyncThunk(
  get_tool_endpoint,
  get_tool_function,
);


const update_tool_endpoint: string = `${TOOLS_API}/update`;
async function update_tool_function(args: {
  toolId: string;
  name?: string;
  description?: string;
  command?: string;
  mcp_config?: Record<string, unknown>;
  credentials?: Record<string, string>;
  auth_type?: string;
  auth_status?: string;
  oauth_provider?: string | null;
  oauth_tokens?: Record<string, unknown>;
  tool_permissions?: Record<string, string>;
  connected_account_email?: string | null;
  enabled?: boolean;
}): Promise<{ ok: boolean; tool: Record<string, unknown> }> {
  const { toolId, ...updates } = args;
  const res = await fetch(`${TOOLS_API}/${toolId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  return data as { ok: boolean; tool: Record<string, unknown> };
}
export const UPDATE_TOOL = createAsyncThunk(
  update_tool_endpoint,
  update_tool_function,
);


const delete_tool_endpoint: string = `${TOOLS_API}/delete`;
async function delete_tool_function(toolId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${TOOLS_API}/${toolId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean };
}
export const DELETE_TOOL = createAsyncThunk(
  delete_tool_endpoint,
  delete_tool_function,
);


// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------


const discover_tool_endpoint: string = `${TOOLS_API}/discover`;
async function discover_tool_function(toolId: string): Promise<{ ok: boolean; tool: Record<string, unknown> }> {
  const res = await fetch(`${TOOLS_API}/${toolId}/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean; tool: Record<string, unknown> };
}
export const DISCOVER_TOOL = createAsyncThunk(
  discover_tool_endpoint,
  discover_tool_function,
);


const load_user_toolkit_endpoint: string = `${TOOLS_API}/load_user_toolkit`;
async function load_user_toolkit_function(): Promise<Record<string, unknown> | null> {
  const res = await fetch(load_user_toolkit_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Record<string, unknown> | null;
}
export const LOAD_USER_TOOLKIT = createAsyncThunk(
  load_user_toolkit_endpoint,
  load_user_toolkit_function,
);


// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------


const oauth_callback_endpoint: string = `${TOOLS_API}/oauth/callback`;
async function oauth_callback_function(params: { code: string; state?: string }): Promise<string> {
  const query = new URLSearchParams();
  query.set('code', params.code);
  if (params.state) query.set('state', params.state);
  const res = await fetch(`${oauth_callback_endpoint}?${query.toString()}`, {
    method: 'GET',
  });
  const html = await res.text();
  return html;
}
export const OAUTH_CALLBACK = createAsyncThunk(
  oauth_callback_endpoint,
  oauth_callback_function,
);


const oauth_start_endpoint: string = `${TOOLS_API}/oauth/start`;
async function oauth_start_function(toolId: string): Promise<{ auth_url: string }> {
  const res = await fetch(`${TOOLS_API}/${toolId}/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { auth_url: string };
}
export const OAUTH_START = createAsyncThunk(
  oauth_start_endpoint,
  oauth_start_function,
);


const oauth_disconnect_endpoint: string = `${TOOLS_API}/oauth/disconnect`;
async function oauth_disconnect_function(toolId: string): Promise<{ ok: boolean; tool: Record<string, unknown> }> {
  const res = await fetch(`${TOOLS_API}/${toolId}/oauth/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean; tool: Record<string, unknown> };
}
export const OAUTH_DISCONNECT = createAsyncThunk(
  oauth_disconnect_endpoint,
  oauth_disconnect_function,
);
