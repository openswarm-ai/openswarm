// Last-interaction timestamp; drives idle dimming, snooze prompts, session sync close.

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface InteractionState {
  /** Date.now() of the most recent user interaction. */
  lastInteractionAt: number;
  /** App start; for time-spent metrics and idle calcs. */
  appStartedAt: number;
  /** Coarse surface label for snooze-prompt context. */
  lastSurface: string | null;
}

const initialState: InteractionState = {
  lastInteractionAt: Date.now(),
  appStartedAt: Date.now(),
  lastSurface: null,
};

const slice = createSlice({
  name: 'interaction',
  initialState,
  reducers: {
    interactionRecorded(state, action: PayloadAction<{ surface?: string; at?: number }>) {
      state.lastInteractionAt = action.payload.at ?? Date.now();
      if (action.payload.surface) state.lastSurface = action.payload.surface;
    },
    appStartReset(state) {
      state.appStartedAt = Date.now();
      state.lastInteractionAt = state.appStartedAt;
      state.lastSurface = null;
    },
  },
});

export const { interactionRecorded, appStartReset } = slice.actions;
export default slice.reducer;
