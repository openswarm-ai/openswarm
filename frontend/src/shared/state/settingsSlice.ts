import { createSlice } from '@reduxjs/toolkit';
import {
  GET_SETTINGS,
  UPDATE_SETTINGS,
  RESET_SYSTEM_PROMPT,
} from '@/shared/backend-bridge/apps/settings';
import type { AppSettings } from '@/shared/backend-bridge/apps/settings';

export const DEFAULT_SYSTEM_PROMPT =
  `You are a personal AI assistant running inside OpenSwarm.\n\n` +
  `## Tool Priority\n` +
  `When a dedicated MCP tool exists for a task, use it directly — do not use the browser for things MCP tools can handle.\n` +
  `Priority order:\n` +
  `1. MCP tools first (Reddit, Google Workspace, Twitter, etc.) — fastest and most reliable\n` +
  `2. WebSearch / WebFetch — for general web lookups without a dedicated MCP\n` +
  `3. BrowserAgent — only when you need to visually interact with a website, fill forms, or do something no other tool can handle\n\n` +
  `## Tool Call Style\n` +
  `Default: do not narrate routine tool calls — just call the tool.\n` +
  `Narrate only when it helps: multi-step work, complex problems, or when the user explicitly asks.\n` +
  `Keep narration brief. Use plain language.\n\n` +
  `## Interaction Style\n` +
  `Be direct and action-oriented. Do not ask clarifying questions unless genuinely ambiguous — ` +
  `make reasonable assumptions and act. If you need to ask, use the AskUserQuestion tool.\n` +
  `Do not over-explain what you are about to do. Just do it and show the results.`;

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
    theme: 'dark',
    new_agent_shortcut: 'Meta+l',
    anthropic_api_key: null,
    browser_homepage: 'https://www.google.com',
    auto_select_mode_on_new_agent: false,
    expand_new_chats_in_dashboard: true,
    auto_reveal_sub_agents: true,
    dev_mode: false,
  },
  loading: false,
  loaded: false,
  modalOpen: false,
};

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
      .addCase(GET_SETTINGS.pending, (state) => {
        state.loading = true;
      })
      .addCase(GET_SETTINGS.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.data = action.payload;
      })
      .addCase(GET_SETTINGS.rejected, (state) => {
        state.loading = false;
        state.loaded = true;
      })
      .addCase(UPDATE_SETTINGS.fulfilled, (state, action) => {
        state.data = action.payload.settings;
      })
      .addCase(RESET_SYSTEM_PROMPT.fulfilled, (state, action) => {
        state.data = action.payload.settings;
      });
  },
});

export const { openSettingsModal, closeSettingsModal } = settingsSlice.actions;
export default settingsSlice.reducer;
