import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';
import { notifyNeedsAttention } from '@/shared/notifications';

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
    const data = (await r.json()) as { attention: TriggerAttentionItem[] };
    const first = data.attention?.[0];
    if (first) {
      // App hidden = the in-app pill can't reach them; the OS notification can (no-op when visible).
      notifyNeedsAttention(
        `A watcher on "${first.workflow_title}" needs you`,
        first.needs || first.last_error || `${first.consecutive_failures} failures in a row`,
        `trigger-health:${first.trigger_id}`,
      );
    }
    return data;
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
