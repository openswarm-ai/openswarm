import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { PersonalizedStarter } from '@/shared/state/settingsSlice';

// Transient bridge between the v3 flow overlay and the dashboard: the overlay finishes, stashes the prep payload here, and the dashboard's reveal hook consumes it exactly once to seed the canvas.

export interface PreppedJob {
  sessionId: string;
  title: string;
  kind: 'audit' | 'app';
  /** The one-clause "why we started this for you", shown in the reveal note. */
  reason?: string;
}

export interface OnboardingV3State {
  /** True while the full-screen flow owns the window; suppresses onboarding v2. */
  flowActive: boolean;
  /** One-shot: set on finish, cleared by the reveal seeder after cards land. */
  revealPending: boolean;
  greeting: string | null;
  starters: PersonalizedStarter[];
  scanSummary: string | null;
  /** Read-only audit prompt to launch as a live agent at reveal; null = chips only. */
  autoPrompt: string | null;
  /** Background jobs launched mid-flow (audit + app build); the keep/discard toast owns their fate. */
  prepped: PreppedJob[];
}

const initialState: OnboardingV3State = {
  flowActive: false,
  revealPending: false,
  greeting: null,
  starters: [],
  scanSummary: null,
  autoPrompt: null,
  prepped: [],
};

const onboardingV3Slice = createSlice({
  name: 'onboardingV3',
  initialState,
  reducers: {
    setFlowActive(state, action: PayloadAction<boolean>) {
      state.flowActive = action.payload;
    },
    stageReveal(state, action: PayloadAction<{ greeting: string | null; starters: PersonalizedStarter[]; scanSummary: string | null; autoPrompt: string | null }>) {
      state.revealPending = true;
      state.greeting = action.payload.greeting;
      state.starters = action.payload.starters;
      state.scanSummary = action.payload.scanSummary;
      state.autoPrompt = action.payload.autoPrompt;
    },
    addPreppedJob(state, action: PayloadAction<PreppedJob>) {
      if (!state.prepped.some((j) => j.sessionId === action.payload.sessionId)) state.prepped.push(action.payload);
    },
    clearPrepped(state) {
      state.prepped = [];
    },
    clearReveal(state) {
      state.revealPending = false;
      state.scanSummary = null;
      state.autoPrompt = null;
    },
  },
});

export const { setFlowActive, stageReveal, clearReveal, addPreppedJob, clearPrepped } = onboardingV3Slice.actions;
export default onboardingV3Slice.reducer;
