import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { PersonalizedStarter } from '@/shared/state/settingsSlice';

// Transient bridge between the v3 flow overlay and the dashboard: the overlay finishes, stashes the prep payload here, and the dashboard's reveal hook consumes it exactly once to seed the canvas.

export interface OnboardingV3State {
  /** True while the full-screen flow owns the window; suppresses onboarding v2. */
  flowActive: boolean;
  /** One-shot: set on finish, cleared by the reveal seeder after cards land. */
  revealPending: boolean;
  greeting: string | null;
  starters: PersonalizedStarter[];
  scanSummary: string | null;
}

const initialState: OnboardingV3State = {
  flowActive: false,
  revealPending: false,
  greeting: null,
  starters: [],
  scanSummary: null,
};

const onboardingV3Slice = createSlice({
  name: 'onboardingV3',
  initialState,
  reducers: {
    setFlowActive(state, action: PayloadAction<boolean>) {
      state.flowActive = action.payload;
    },
    stageReveal(state, action: PayloadAction<{ greeting: string | null; starters: PersonalizedStarter[]; scanSummary: string | null }>) {
      state.revealPending = true;
      state.greeting = action.payload.greeting;
      state.starters = action.payload.starters;
      state.scanSummary = action.payload.scanSummary;
    },
    clearReveal(state) {
      state.revealPending = false;
      state.scanSummary = null;
    },
  },
});

export const { setFlowActive, stageReveal, clearReveal } = onboardingV3Slice.actions;
export default onboardingV3Slice.reducer;
