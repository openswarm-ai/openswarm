import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const APP_BUILDER_API: string = `${API_BASE}/app_builder`;

// ---------------------------------------------------------------------------
// File serving
// ---------------------------------------------------------------------------


const serve_app_source_file_endpoint: string = `${APP_BUILDER_API}/app/source_dir`;
async function serve_app_source_file_function(payload: {
  appId: string;
  filepath: string;
}): Promise<string> {
  const res = await fetch(`${APP_BUILDER_API}/app/${payload.appId}/source_dir/${payload.filepath}`, {
    method: 'GET',
  });
  const text = await res.text();
  return text;
}
export const SERVE_APP_SOURCE_FILE = createAsyncThunk(
  serve_app_source_file_endpoint,
  serve_app_source_file_function,
);


const serve_app_file_endpoint: string = `${APP_BUILDER_API}/serve`;
async function serve_app_file_function(payload: {
  appId: string;
  filepath: string;
}): Promise<string> {
  const res = await fetch(`${APP_BUILDER_API}/${payload.appId}/serve/${payload.filepath}`, {
    method: 'GET',
  });
  const text = await res.text();
  return text;
}
export const SERVE_APP_FILE = createAsyncThunk(
  serve_app_file_endpoint,
  serve_app_file_function,
);


// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------


const read_app_endpoint: string = `${APP_BUILDER_API}/app`;
async function read_app_function(appId: string): Promise<{ files: Record<string, string>; meta: Record<string, unknown> | null }> {
  const res = await fetch(`${APP_BUILDER_API}/app/${appId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { files: Record<string, string>; meta: Record<string, unknown> | null };
}
export const READ_APP = createAsyncThunk(
  read_app_endpoint,
  read_app_function,
);


const seed_app_endpoint: string = `${APP_BUILDER_API}/app/seed`;
async function seed_app_function(body: {
  app_id: string;
  files?: Record<string, string> | null;
  meta?: Record<string, unknown> | null;
}): Promise<{ path: string }> {
  const res = await fetch(seed_app_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { path: string };
}
export const SEED_APP = createAsyncThunk(
  seed_app_endpoint,
  seed_app_function,
);


const write_app_file_endpoint: string = `${APP_BUILDER_API}/app/file`;
async function write_app_file_function(payload: {
  appId: string;
  filepath: string;
  content: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${APP_BUILDER_API}/app/${payload.appId}/file/${payload.filepath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: payload.content }),
  });
  const data = await res.json();
  return data as { ok: boolean };
}
export const WRITE_APP_FILE = createAsyncThunk(
  write_app_file_endpoint,
  write_app_file_function,
);


const delete_app_file_endpoint: string = `${APP_BUILDER_API}/app/file/delete`;
async function delete_app_file_function(payload: {
  appId: string;
  filepath: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${APP_BUILDER_API}/app/${payload.appId}/file/${payload.filepath}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean };
}
export const DELETE_APP_FILE = createAsyncThunk(
  delete_app_file_endpoint,
  delete_app_file_function,
);


// ---------------------------------------------------------------------------
// App CRUD
// ---------------------------------------------------------------------------


const list_apps_endpoint: string = `${APP_BUILDER_API}/list`;
async function list_apps_function(): Promise<{ apps: Record<string, unknown>[] }> {
  const res = await fetch(list_apps_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { apps: Record<string, unknown>[] };
}
export const LIST_APPS = createAsyncThunk(
  list_apps_endpoint,
  list_apps_function,
);


const get_app_endpoint: string = `${APP_BUILDER_API}/get`;
async function get_app_function(appId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_BUILDER_API}/${appId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const GET_APP = createAsyncThunk(
  get_app_endpoint,
  get_app_function,
);


const create_app_endpoint: string = `${APP_BUILDER_API}/create`;
async function create_app_function(body: {
  name: string;
  description?: string;
  icon?: string;
  files?: Record<string, string> | null;
  thumbnail?: string | null;
}): Promise<{ ok: boolean; app: Record<string, unknown> }> {
  const res = await fetch(create_app_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { ok: boolean; app: Record<string, unknown> };
}
export const CREATE_APP = createAsyncThunk(
  create_app_endpoint,
  create_app_function,
);


const update_app_endpoint: string = `${APP_BUILDER_API}/update`;
async function update_app_function(payload: {
  appId: string;
  name?: string;
  description?: string;
  icon?: string;
  thumbnail?: string | null;
}): Promise<{ ok: boolean; app: Record<string, unknown> }> {
  const { appId, ...updates } = payload;
  const res = await fetch(`${APP_BUILDER_API}/${appId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  return data as { ok: boolean; app: Record<string, unknown> };
}
export const UPDATE_APP = createAsyncThunk(
  update_app_endpoint,
  update_app_function,
);


const delete_app_endpoint: string = `${APP_BUILDER_API}/delete`;
async function delete_app_function(appId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${APP_BUILDER_API}/${appId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean };
}
export const DELETE_APP = createAsyncThunk(
  delete_app_endpoint,
  delete_app_function,
);


// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------


const execute_app_endpoint: string = `${APP_BUILDER_API}/execute`;
async function execute_app_function(appId: string): Promise<{
  app_id: string;
  app_name: string;
  frontend_code: string;
  backend_result: Record<string, unknown> | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
}> {
  const res = await fetch(execute_app_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  const data = await res.json();
  return data as {
    app_id: string;
    app_name: string;
    frontend_code: string;
    backend_result: Record<string, unknown> | null;
    stdout: string | null;
    stderr: string | null;
    error: string | null;
  };
}
export const EXECUTE_APP = createAsyncThunk(
  execute_app_endpoint,
  execute_app_function,
);
