// Tracks the timestamp of the most recent user interaction in the app
// (keystrokes, clicks, scrolls). Drives:
//   - Idle UI dimming
//   - "Are you still there?" snooze prompts
//   - Session sync — last interaction timestamp piggybacks on the dump
//     submitted to the backend at session close
//
// Intentionally lightweight; this is a single Redux number plus a "last
// surface" string for context.

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface InteractionState {
  /** Wall-clock ms (Date.now()) of the most recent user interaction. */
  lastInteractionAt: number;
  /** App start, useful for "time spent in app" metrics & idle calculations. */
  appStartedAt: number;
  /** A coarse label for what surface the user last interacted with — useful
   * for the "are you still there?" prompt (so we can resume them in
   * context). */
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
