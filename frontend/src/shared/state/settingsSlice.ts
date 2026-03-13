import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const API_BASE = `http://${window.location.hostname}:8324/api/settings`;

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
    default_system_prompt: null,
    default_folder: null,
    default_model: 'sonnet',
    default_mode: 'agent',
    default_max_turns: null,
    zoom_sensitivity: 50,
    theme: 'dark',
    new_agent_shortcut: 'Meta+l',
    anthropic_api_key: null,
  },
  loading: false,
  loaded: false,
  modalOpen: false,
};

export const fetchSettings = createAsyncThunk('settings/fetch', async () => {
  const res = await fetch(API_BASE);
  return (await res.json()) as AppSettings;
});

export const updateSettings = createAsyncThunk(
  'settings/update',
  async (settings: AppSettings) => {
    const res = await fetch(API_BASE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    return data.settings as AppSettings;
  }
);

export const browseDirectories = createAsyncThunk(
  'settings/browseDirectories',
  async (path: string) => {
    const res = await fetch(`${API_BASE}/browse-directories?path=${encodeURIComponent(path)}`);
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
      });
  },
});

export const { openSettingsModal, closeSettingsModal } = settingsSlice.actions;
export default settingsSlice.reducer;
