import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const SETTINGS_API = `${API_BASE}/settings`;

export const DEFAULT_SYSTEM_PROMPT =
  `Ask the user as many follow ups as needed in order to eliminate any possible ambiguity. ` +
  `When asking the user questions, use the AskUserQuestion tool.\n\n` +
  `You are an unstopable Agent that does whatever is needed to achieve the task. ` +
  `You are particularly gifted at coding, so when needed, transpose ordinary tasks into coding tasks.\n\n` +
  `If a Browser is selected, prioritize this over other tools when it makes sense (so the user also has observability).\n\n` +
  `If multiple Browsers are selected, parallelize the tasks across them.`;

export interface AppSettings {
  default_system_prompt: string | null;
  default_folder: string | null;
  default_model: string;
  default_mode: string;
  default_max_turns: number | null;
  zoom_sensitivity: number;
  theme: string;
  radius_scale: number;
  new_agent_shortcut: string;
  anthropic_api_key: string | null;
  browser_homepage: string;
  auto_select_mode_on_new_agent: boolean;
  expand_new_chats_in_dashboard: boolean;
  auto_reveal_sub_agents: boolean;
  dev_mode: boolean;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  directories: string[];
  files: string[];
}

interface SettingsState {
  data: AppSettings;
  loading: boolean;
  loaded: boolean;
  modalOpen: boolean;
}

const initialState: SettingsState = {
  data: {
    default_system_prompt: DEFAULT_SYSTEM_PROMPT,
    default_folder: null,
    default_model: 'sonnet',
    default_mode: 'agent',
    default_max_turns: null,
    zoom_sensitivity: 50,
    theme: 'midnight',
    radius_scale: 1.0,
    new_agent_shortcut: 'Meta+l',
    anthropic_api_key: null,
    browser_homepage: 'https://www.google.com',
    auto_select_mode_on_new_agent: false,
    expand_new_chats_in_dashboard: false,
    auto_reveal_sub_agents: true,
    dev_mode: false,
  },
  loading: false,
  loaded: false,
  modalOpen: false,
};

export const fetchSettings = createAsyncThunk('settings/fetch', async () => {
  const res = await fetch(SETTINGS_API);
  return (await res.json()) as AppSettings;
});

export const updateSettings = createAsyncThunk(
  'settings/update',
  async (settings: AppSettings) => {
    const res = await fetch(SETTINGS_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    return data.settings as AppSettings;
  }
);

export const resetSystemPrompt = createAsyncThunk(
  'settings/resetSystemPrompt',
  async () => {
    const res = await fetch(`${SETTINGS_API}/reset-system-prompt`, { method: 'POST' });
    const data = await res.json();
    return data.settings as AppSettings;
  }
);

export const browseDirectories = createAsyncThunk(
  'settings/browseDirectories',
  async (path: string) => {
    const res = await fetch(`${SETTINGS_API}/browse-directories?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error((await res.json()).detail);
    return (await res.json()) as BrowseResult;
  }
);

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    openSettingsModal(state) {
      state.modalOpen = true;
    },
    closeSettingsModal(state) {
      state.modalOpen = false;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSettings.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchSettings.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.data = action.payload;
      })
      .addCase(fetchSettings.rejected, (state) => {
        state.loading = false;
        state.loaded = true;
      })
      .addCase(updateSettings.fulfilled, (state, action) => {
        state.data = action.payload;
      })
      .addCase(resetSystemPrompt.fulfilled, (state, action) => {
        state.data = action.payload;
      });
  },
});

export const { openSettingsModal, closeSettingsModal } = settingsSlice.actions;
export default settingsSlice.reducer;
