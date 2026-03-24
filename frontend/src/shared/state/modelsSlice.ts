import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const AGENTS_API = `${API_BASE}/agents`;

export interface ModelOption {
  value: string;
  label: string;
  version?: string;
  context_window: number;
}

interface ModelsState {
  byProvider: Record<string, ModelOption[]>;
  loaded: boolean;
}

const initialState: ModelsState = {
  byProvider: {},
  loaded: false,
};

export const fetchModels = createAsyncThunk('models/fetchModels', async () => {
  const res = await fetch(`${AGENTS_API}/models`);
  if (!res.ok) throw new Error('Failed to fetch models');
  const data = await res.json();
  // API returns { models: { provider: [...] } }
  const models = data.models || data;
  return models as Record<string, ModelOption[]>;
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
