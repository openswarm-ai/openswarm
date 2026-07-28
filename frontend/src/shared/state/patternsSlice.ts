import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

export interface PatternCadence {
  kind: 'weekly' | 'daily' | 'irregular';
  on_days: number[];
  hour: number;
}

export interface PatternSuggestion {
  id: string;
  description: string;
  evidence_count: number;
  first_seen: string | null;
  last_seen: string | null;
  cadence: PatternCadence;
  workflow_title: string;
  workflow_steps: string[];
}

interface PatternsState {
  suggestions: PatternSuggestion[];
  toastOpen: boolean;
  accepting: boolean;
}

const initialState: PatternsState = {
  suggestions: [],
  toastOpen: false,
  accepting: false,
};

export const fetchPatternSuggestions = createAsyncThunk(
  'patterns/fetch',
  async (): Promise<{ suggestions: PatternSuggestion[] }> => {
    const r = await fetch(`${API_BASE}/patterns/suggestions`);
    return (await r.json()) as { suggestions: PatternSuggestion[] };
  },
);

export const acceptPatternSuggestion = createAsyncThunk(
  'patterns/accept',
  async (suggestionId: string): Promise<{ workflow: { id: string } }> => {
    const r = await fetch(`${API_BASE}/patterns/suggestions/${suggestionId}/accept`, { method: 'POST' });
    if (!r.ok) throw new Error(`accept failed: ${r.status}`);
    return (await r.json()) as { workflow: { id: string } };
  },
);

export const dismissPatternSuggestion = createAsyncThunk(
  'patterns/dismiss',
  async (suggestionId: string): Promise<string> => {
    await fetch(`${API_BASE}/patterns/suggestions/${suggestionId}/dismiss`, { method: 'POST' });
    return suggestionId;
  },
);

const patternsSlice = createSlice({
  name: 'patterns',
  initialState,
  reducers: {
    hidePatternToast(state) {
      state.toastOpen = false;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchPatternSuggestions.fulfilled, (state, action) => {
      state.suggestions = action.payload.suggestions ?? [];
      state.toastOpen = state.suggestions.length > 0;
    });
    builder.addCase(acceptPatternSuggestion.pending, (state) => {
      state.accepting = true;
    });
    builder.addCase(acceptPatternSuggestion.fulfilled, (state, action) => {
      state.accepting = false;
      state.suggestions = state.suggestions.filter((s) => s.id !== action.meta.arg);
      // The user acted; don't immediately push the next offer in their face.
      state.toastOpen = false;
    });
    builder.addCase(acceptPatternSuggestion.rejected, (state) => {
      state.accepting = false;
    });
    builder.addCase(dismissPatternSuggestion.fulfilled, (state, action) => {
      state.suggestions = state.suggestions.filter((s) => s.id !== action.payload);
      state.toastOpen = state.suggestions.length > 0;
    });
  },
});

export const { hidePatternToast } = patternsSlice.actions;
export default patternsSlice.reducer;
