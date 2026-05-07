import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const SETTINGS_API = `${API_BASE}/settings`;

export const DEFAULT_SYSTEM_PROMPT =
  `You are a personal AI assistant running inside OpenSwarm.\n\n` +
  `## Tool Priority\n` +
  `When a dedicated MCP tool exists for a task, use it directly — do not use the browser for things MCP tools can handle.\n` +
  `Priority order:\n` +
  `1. MCP tools first (Reddit, Google Workspace, etc.) — fastest and most reliable\n` +
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

export interface CustomProvider {
  name: string;
  base_url: string;
  api_key: string;
  models: Array<{ value: string; label: string; context_window?: number }>;
}

export interface SubscriptionUsage {
  requests_in_window: number;
  plan_limit: number;
  window_hours: number;
  window_ends_at: number;       // unix ms
}

export interface AppSettings {
  default_system_prompt: string | null;
  default_folder: string | null;
  default_model: string;
  default_mode: string;
  default_max_turns: number | null;
  default_thinking_level: 'off' | 'low' | 'medium' | 'high' | 'auto';
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
  // Optional managed-subscription state (surfaces only when user has
  // subscribed via the cloud). Mirrors AppSettings on the backend.
  connection_mode?: 'own_key' | 'openswarm-pro';
  openswarm_bearer_token?: string | null;
  openswarm_proxy_url?: string | null;
  openswarm_subscription_plan?: string | null;
  openswarm_subscription_expires?: string | null;
  openswarm_usage_cached?: SubscriptionUsage | null;
  // Identity (v1.0.30+). Populated after a successful Google OAuth or
  // magic-link sign-in via /api/auth/signin-activate. Stripe checkout also
  // populates these because the cloud's bearer-mint always returns user info.
  user_id?: string | null;
  user_email?: string | null;
  signin_method?: 'google' | 'magic_link' | 'stripe' | null;
  // Anonymous device identifier. Generated locally on first run, persists
  // across launches. Used to bind cloud OAuth flows to this install and to
  // stitch anonymous → authenticated PostHog Persons after sign-in.
  installation_id?: string | null;
}

export interface ActivateSubscriptionPayload {
  token: string;
  plan?: string | null;
  expires?: string | null;
}

export interface ActivateSigninPayload {
  token: string;
  signin_method: 'google' | 'magic_link';
  email?: string | null;
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
  /** When non-null, Settings opens to this tab instead of 'general'. */
  initialTab: string | null;
}

const initialState: SettingsState = {
  data: {
    default_system_prompt: DEFAULT_SYSTEM_PROMPT,
    default_folder: null,
    default_model: 'sonnet',
    default_mode: 'agent',
    default_max_turns: null,
    default_thinking_level: 'auto',
    zoom_sensitivity: 50,
    theme: 'dark',
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
  initialTab: null,
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

// POST /api/subscription/activate — called after the desktop catches an
// openswarm://auth?token=... deep link. Validates + persists on the backend,
// then refreshes settings so the Settings UI flips to "Pro" mode.
export const activateSubscription = createAsyncThunk(
  'settings/activateSubscription',
  async (payload: ActivateSubscriptionPayload, { dispatch }) => {
    const res = await fetch(`${API_BASE}/subscription/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.text()) || 'Activation failed');
    // Pull the fresh settings so UI reflects connection_mode + plan.
    await dispatch(fetchSettings());
    return (await res.json()) as { ok: boolean; plan: string };
  }
);

// POST /api/auth/signin-activate — called after the desktop catches the
// bearer from a Google OAuth / magic-link sign-in flow. Validates the
// bearer with the cloud (checks signature + user_id + email) and persists
// it locally as a free-tier identity. The same backend route also handles
// "user signed in AND has an active subscription" — plan/expires are set
// when the cloud returns them.
export const activateSignin = createAsyncThunk(
  'settings/activateSignin',
  async (payload: ActivateSigninPayload, { dispatch }) => {
    const res = await fetch(`${API_BASE}/auth/signin-activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.text()) || 'Sign-in failed');
    await dispatch(fetchSettings());
    return (await res.json()) as {
      ok: boolean;
      user_id: string;
      email: string;
      plan: string;
      signin_method: 'google' | 'magic_link';
    };
  },
);

// POST /api/auth/signout — revokes the cloud-side bearer and clears local
// identity fields. Brings the user back to the sign-in gate.
export const signOut = createAsyncThunk(
  'settings/signOut',
  async (_: void, { dispatch }) => {
    const res = await fetch(`${API_BASE}/auth/signout`, { method: 'POST' });
    if (!res.ok) throw new Error('Sign-out failed');
    await dispatch(fetchSettings());
    return true;
  },
);

// POST /api/subscription/disconnect — clears bearer + reverts to own_key.
// Doesn't cancel the Stripe subscription (that's the Portal).
export const disconnectSubscription = createAsyncThunk(
  'settings/disconnectSubscription',
  async (_: void, { dispatch }) => {
    const res = await fetch(`${API_BASE}/subscription/disconnect`, { method: 'POST' });
    if (!res.ok) throw new Error('Disconnect failed');
    await dispatch(fetchSettings());
    return true;
  }
);

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    openSettingsModal(state, action: PayloadAction<string | undefined>) {
      state.modalOpen = true;
      state.initialTab = action.payload ?? null;
    },
    closeSettingsModal(state) {
      state.modalOpen = false;
      state.initialTab = null;
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
