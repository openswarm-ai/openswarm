import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend/base_routes';

const MODES_API: string = `${API_BASE}/modes`;

// ---------------------------------------------------------------------------
// Mode CRUD
// ---------------------------------------------------------------------------


const list_modes_endpoint: string = `${MODES_API}/list`;
async function list_modes_function(): Promise<{ modes: Record<string, unknown>[]; builtin_defaults: Record<string, Record<string, unknown>> }> {
  const res = await fetch(list_modes_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { modes: Record<string, unknown>[]; builtin_defaults: Record<string, Record<string, unknown>> };
}
export const LIST_MODES = createAsyncThunk(
  list_modes_endpoint,
  list_modes_function,
);


const get_mode_endpoint: string = `${MODES_API}/get`;
async function get_mode_function(modeId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${MODES_API}/${modeId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const GET_MODE = createAsyncThunk(
  get_mode_endpoint,
  get_mode_function,
);


const create_mode_endpoint: string = `${MODES_API}/create`;
async function create_mode_function(body: {
  name: string;
  description?: string;
  system_prompt?: string | null;
  tools?: string[] | null;
  default_next_mode?: string | null;
  icon?: string;
  color?: string;
  default_folder?: string | null;
}): Promise<{ ok: boolean; mode: Record<string, unknown> }> {
  const res = await fetch(create_mode_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { ok: boolean; mode: Record<string, unknown> };
}
export const CREATE_MODE = createAsyncThunk(
  create_mode_endpoint,
  create_mode_function,
);


const update_mode_endpoint: string = `${MODES_API}/update`;
async function update_mode_function(args: {
  modeId: string;
  name?: string;
  description?: string;
  system_prompt?: string | null;
  tools?: string[] | null;
  default_next_mode?: string | null;
  icon?: string;
  color?: string;
  default_folder?: string | null;
}): Promise<{ ok: boolean; mode: Record<string, unknown> }> {
  const { modeId, ...updates } = args;
  const res = await fetch(`${MODES_API}/${modeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  return data as { ok: boolean; mode: Record<string, unknown> };
}
export const UPDATE_MODE = createAsyncThunk(
  update_mode_endpoint,
  update_mode_function,
);


const reset_mode_endpoint: string = `${MODES_API}/reset`;
async function reset_mode_function(modeId: string): Promise<{ ok: boolean; mode: Record<string, unknown> }> {
  const res = await fetch(`${MODES_API}/${modeId}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean; mode: Record<string, unknown> };
}
export const RESET_MODE = createAsyncThunk(
  reset_mode_endpoint,
  reset_mode_function,
);


const delete_mode_endpoint: string = `${MODES_API}/delete`;
async function delete_mode_function(modeId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${MODES_API}/${modeId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean };
}
export const DELETE_MODE = createAsyncThunk(
  delete_mode_endpoint,
  delete_mode_function,
);


const get_mode_by_id_endpoint: string = `${MODES_API}/get_mode_by_id`;
async function get_mode_by_id_function(modeId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(get_mode_by_id_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode_id: modeId }),
  });
  const data = await res.json();
  return data as Record<string, unknown> | null;
}
export const GET_MODE_BY_ID = createAsyncThunk(
  get_mode_by_id_endpoint,
  get_mode_by_id_function,
);
