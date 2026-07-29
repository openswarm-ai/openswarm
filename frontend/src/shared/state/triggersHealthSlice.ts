import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

export interface TriggerAttentionItem {
  workflow_id: string;
  workflow_title: string;
  trigger_id: string;
  kind: string;
  consecutive_failures: number;
  last_error: string;
  /** The healer's one-line "what a human needs to do", when it knows. */
  needs?: string;
}

interface TriggersHealthState {
  items: TriggerAttentionItem[];
  toastOpen: boolean;
}

const initialState: TriggersHealthState = { items: [], toastOpen: false };

export const fetchTriggersAttention = createAsyncThunk(
  'triggersHealth/fetch',
  async (): Promise<{ attention: TriggerAttentionItem[] }> => {
    const r = await fetch(`${API_BASE}/workflows/triggers/attention`);
    return (await r.json()) as { attention: TriggerAttentionItem[] };
  },
);

const triggersHealthSlice = createSlice({
  name: 'triggersHealth',
  initialState,
  reducers: {
    hideTriggersHealthToast(state) {
      state.toastOpen = false;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchTriggersAttention.fulfilled, (state, action) => {
      state.items = action.payload.attention ?? [];
      state.toastOpen = state.items.length > 0;
    });
  },
});

export const { hideTriggersHealthToast } = triggersHealthSlice.actions;
export default triggersHealthSlice.reducer;
