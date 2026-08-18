import { PayloadAction } from '@reduxjs/toolkit';
import type { DashboardLayoutState } from './dashboardLayoutModel';

export const glowReducers = {
  setGlowingBrowserCards(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserIds: string[]; sessionId: string; label?: string }>,
  ) {
    const { browserIds, sessionId, label } = action.payload;
    for (const id of browserIds) {
      state.glowingBrowserCards[id] = { sourceId: sessionId, fading: false, label };
    }
  },

  fadeGlowingBrowserCards(state: DashboardLayoutState, action: PayloadAction<string>) {
    const sessionId = action.payload;
    for (const entry of Object.values(state.glowingBrowserCards)) {
      if (entry.sourceId === sessionId) entry.fading = true;
    }
  },

  clearGlowingBrowserCards(state: DashboardLayoutState, action: PayloadAction<string>) {
    const sessionId = action.payload;
    for (const [browserId, entry] of Object.entries(state.glowingBrowserCards)) {
      if (entry.sourceId === sessionId) delete state.glowingBrowserCards[browserId];
    }
  },

  clearAllGlowingBrowserCards(state: DashboardLayoutState) {
    state.glowingBrowserCards = {};
  },

  setGlowingAgentCard(
    state: DashboardLayoutState,
    action: PayloadAction<{ sessionId: string; sourceId: string; sourceYRatio?: number; label?: string }>,
  ) {
    const { sessionId, sourceId, sourceYRatio, label } = action.payload;
    state.glowingAgentCards[sessionId] = { sourceId, fading: false, sourceYRatio, label };
  },

  fadeGlowingAgentCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    const entry = state.glowingAgentCards[action.payload];
    if (entry) entry.fading = true;
  },

  clearGlowingAgentCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.glowingAgentCards[action.payload];
  },
};
