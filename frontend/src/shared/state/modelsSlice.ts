import { createSlice } from '@reduxjs/toolkit';
import { SUBSCRIPTIONS_STATUS } from '@/shared/backend-bridge/apps/subscriptions';

interface ModelEntry {
  value: string;
  label: string;
  context_window: number;
  provider: string;
}

interface ModelsState {
  byProvider: Record<string, ModelEntry[]>;
  loading: boolean;
  loaded: boolean;
}

const initialState: ModelsState = { byProvider: {}, loading: false, loaded: false };

function groupByProvider(raw: any[]): Record<string, ModelEntry[]> {
  const grouped: Record<string, ModelEntry[]> = {};
  for (const m of raw) {
    const entry: ModelEntry = {
      value: m.value ?? m.id ?? '',
      label: m.label ?? m.value ?? '',
      context_window: m.context_window ?? 200_000,
      provider: m.provider ?? 'Unknown',
    };
    const key = entry.provider.charAt(0).toUpperCase() + entry.provider.slice(1);
    (grouped[key] ??= []).push(entry);
  }
  return grouped;
}

const modelsSlice = createSlice({
  name: 'models',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(SUBSCRIPTIONS_STATUS.pending, (state) => { state.loading = true; })
      .addCase(SUBSCRIPTIONS_STATUS.fulfilled, (state, action) => {
        state.loading = false;
        state.loaded = true;
        state.byProvider = groupByProvider((action.payload as any).models ?? []);
      })
      .addCase(SUBSCRIPTIONS_STATUS.rejected, (state) => { state.loading = false; state.loaded = true; });
  },
});

export default modelsSlice.reducer;
