import { createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/backend-bridge/base_routes';

const SETTINGS_API: string = `${API_BASE}/settings`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomProvider {
  name: string;
  base_url: string;
  api_key: string;
  models: Array<{ value: string; label: string; context_window?: number }>;
}

export interface AppSettings {
  default_system_prompt: string | null;
  default_folder: string | null;
  default_model: string;
  default_mode: string;
  default_max_turns: number | null;
  zoom_sensitivity: number;
  theme: 'light' | 'dark';
  new_agent_shortcut: string;
  anthropic_api_key: string | null;
  openai_api_key?: string | null;
  google_api_key?: string | null;
  openrouter_api_key?: string | null;
  custom_providers?: CustomProvider[];
  browser_homepage: string;
  auto_select_mode_on_new_agent: boolean;
  expand_new_chats_in_dashboard: boolean;
  auto_reveal_sub_agents: boolean;
  dev_mode: boolean;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------


const get_settings_endpoint: string = `${SETTINGS_API}/get_settings`;
async function get_settings_function(): Promise<AppSettings> {
  const res = await fetch(get_settings_endpoint, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as AppSettings;
}
export const GET_SETTINGS = createAsyncThunk(
  get_settings_endpoint,
  get_settings_function,
);


const update_settings_endpoint: string = `${SETTINGS_API}/update_settings`;
async function update_settings_function(body: Partial<AppSettings>): Promise<{ ok: boolean; settings: AppSettings }> {
  const res = await fetch(update_settings_endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data as { ok: boolean; settings: AppSettings };
}
export const UPDATE_SETTINGS = createAsyncThunk(
  update_settings_endpoint,
  update_settings_function,
);


const reset_system_prompt_endpoint: string = `${SETTINGS_API}/reset-system-prompt`;
async function reset_system_prompt_function(): Promise<{ ok: boolean; settings: AppSettings }> {
  const res = await fetch(reset_system_prompt_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data as { ok: boolean; settings: AppSettings };
}
export const RESET_SYSTEM_PROMPT = createAsyncThunk(
  reset_system_prompt_endpoint,
  reset_system_prompt_function,
);
