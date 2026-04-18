import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const MODES_API: string = `${API_BASE}/modes`;

export interface Mode {
  id: string;
  name: string;
  description: string;
  system_prompt: string | null;
  tools: string[] | null;
  default_next_mode: string | null;
  is_builtin: boolean;
  icon: string;
  color: string;
  default_folder: string | null;
}

// ---------------------------------------------------------------------------
// Mode CRUD
// ---------------------------------------------------------------------------


const list_modes_endpoint: string = `${MODES_API}/list`;
async function list_modes_function(): Promise<{ modes: Mode[]; builtin_defaults: Record<string, Mode> }> {
  const res = await fetch(list_modes_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { modes: Mode[]; builtin_defaults: Record<string, Mode> };
}
export const LIST_MODES = createAsyncThunk(
  list_modes_endpoint,
  list_modes_function,
);


const get_mode_endpoint: string = `${MODES_API}/get`;
async function get_mode_function(modeId: string): Promise<Mode> {
  const res = await fetch(`${MODES_API}/${modeId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Mode;
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
}): Promise<Mode> {
  const res = await fetch(create_mode_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.mode as Mode;
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
}): Promise<Mode> {
  const { modeId, ...updates } = args;
  const res = await fetch(`${MODES_API}/${modeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  return data.mode as Mode;
}
export const UPDATE_MODE = createAsyncThunk(
  update_mode_endpoint,
  update_mode_function,
);


const reset_mode_endpoint: string = `${MODES_API}/reset`;
async function reset_mode_function(modeId: string): Promise<Mode> {
  const res = await fetch(`${MODES_API}/${modeId}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data.mode as Mode;
}
export const RESET_MODE = createAsyncThunk(
  reset_mode_endpoint,
  reset_mode_function,
);


const delete_mode_endpoint: string = `${MODES_API}/delete`;
async function delete_mode_function(modeId: string): Promise<string> {
  await fetch(`${MODES_API}/${modeId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return modeId;
}
export const DELETE_MODE = createAsyncThunk(
  delete_mode_endpoint,
  delete_mode_function,
);


const get_mode_by_id_endpoint: string = `${MODES_API}/get_mode_by_id`;
async function get_mode_by_id_function(modeId: string): Promise<Mode | null> {
  const res = await fetch(get_mode_by_id_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode_id: modeId }),
  });
  const data = await res.json();
  return data as Mode | null;
}
export const GET_MODE_BY_ID = createAsyncThunk(
  get_mode_by_id_endpoint,
  get_mode_by_id_function,
);
