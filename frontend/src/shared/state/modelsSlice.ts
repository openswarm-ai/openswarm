import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const SUBSCRIPTIONS_API = `${API_BASE}/subscriptions`;

export interface ModelOption {
  value: string;
  label: string;
  version?: string;
  context_window: number;
  reasoning?: boolean;
  provider?: string;
}

interface ModelsState {
  byProvider: Record<string, ModelOption[]>;
  loaded: boolean;
}

const DEFAULT_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: 'sonnet', label: 'Claude Sonnet', context_window: 200000 },
    { value: 'opus', label: 'Claude Opus', context_window: 200000, reasoning: true },
    { value: 'haiku', label: 'Claude Haiku', context_window: 200000 },
  ],
};

const initialState: ModelsState = {
  byProvider: {},
  loaded: false,
};

export const fetchModels = createAsyncThunk('models/fetchModels', async () => {
  try {
    const res = await fetch(`${SUBSCRIPTIONS_API}/status`);
    if (!res.ok) return DEFAULT_MODELS;
    
    const data = await res.json();
    if (!data.running || !data.models?.length) {
      return DEFAULT_MODELS;
    }
    
    // Group models by provider
    const byProvider: Record<string, ModelOption[]> = {};
    for (const m of data.models) {
      const provider = m.provider || 'subscription';
      if (!byProvider[provider]) {
        byProvider[provider] = [];
      }
      byProvider[provider].push({
        value: m.value,
        label: m.label,
        context_window: m.context_window || 200000,
        provider: m.provider,
      });
    }
    
    // Merge with defaults if no models from 9Router
    if (Object.keys(byProvider).length === 0) {
      return DEFAULT_MODELS;
    }
    
    return byProvider;
  } catch {
    return DEFAULT_MODELS;
  }
});

const modelsSlice = createSlice({
  name: 'models',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchModels.fulfilled, (state, action) => {
        state.byProvider = action.payload;
        state.loaded = true;
      })
      .addCase(fetchModels.rejected, (state) => {
        // Mark as loaded even on failure so we fall back to hardcoded options
        state.loaded = true;
      });
  },
});

export default modelsSlice.reducer;
