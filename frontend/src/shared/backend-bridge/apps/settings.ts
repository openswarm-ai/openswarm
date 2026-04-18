import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const SETTINGS_API: string = `${API_BASE}/settings`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------


const get_settings_endpoint: string = SETTINGS_API;
async function get_settings_function(): Promise<Record<string, unknown>> {
  const res = await fetch(get_settings_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as Record<string, unknown>;
}
export const GET_SETTINGS = createAsyncThunk(
  get_settings_endpoint,
  get_settings_function,
);


const update_settings_endpoint: string = SETTINGS_API;
async function update_settings_function(body: {
  default_system_prompt?: string;
  default_folder?: string | null;
  default_model?: string;
  default_mode?: string;
  default_max_turns?: number | null;
  anthropic_api_key?: string | null;
  zoom_sensitivity?: number;
  theme?: string;
  new_agent_shortcut?: string;
  browser_homepage?: string;
  auto_select_mode_on_new_agent?: boolean;
  expand_new_chats_in_dashboard?: boolean;
  auto_reveal_sub_agents?: boolean;
  dev_mode?: boolean;
}): Promise<{ ok: boolean; settings: Record<string, unknown> }> {
  const res = await fetch(update_settings_endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { ok: boolean; settings: Record<string, unknown> };
}
export const UPDATE_SETTINGS = createAsyncThunk(
  update_settings_endpoint,
  update_settings_function,
);


const reset_system_prompt_endpoint: string = `${SETTINGS_API}/reset-system-prompt`;
async function reset_system_prompt_function(): Promise<{ ok: boolean; settings: Record<string, unknown> }> {
  const res = await fetch(reset_system_prompt_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean; settings: Record<string, unknown> };
}
export const RESET_SYSTEM_PROMPT = createAsyncThunk(
  reset_system_prompt_endpoint,
  reset_system_prompt_function,
);
