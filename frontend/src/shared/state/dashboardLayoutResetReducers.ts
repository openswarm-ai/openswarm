import { PayloadAction } from '@reduxjs/toolkit';
import type { DashboardLayoutState } from './dashboardLayoutModel';

export const resetReducers = {
  resetLayout(state: DashboardLayoutState, action: PayloadAction<{ keepBrowserIds?: string[] } | undefined>) {
    const keep = new Set(action.payload?.keepBrowserIds || []);
    const keptBrowsers: typeof state.browserCards = {};
    const keptSuspended: typeof state.suspendedBrowserCards = {};
    for (const id of keep) {
      if (state.browserCards[id]) keptBrowsers[id] = state.browserCards[id];
      if (state.suspendedBrowserCards[id]) keptSuspended[id] = state.suspendedBrowserCards[id];
    }
    state.cards = {};
    state.viewCards = {};
    state.browserCards = keptBrowsers;
    state.tiledCards = {};
    state.minimizedCards = {};
    state.settingsCard = null;
    state.pendingFocusSettingsCard = false;
    state.settingsRequestedTab = null;
    state.marketplaceCard = null;
    state.pendingFocusMarketplaceCard = false;
    state.marketplaceRequestedTab = null;
    state.saveArmed = false;
    // Per-dashboard, same as the cards it tracks; fetchLayout.fulfilled rebuilds it for the new dashboard.
    state.creationOrder = [];
    state.workflowCards = {};
    state.workflowsHub = null;
    state.closedCardPositions = {};
    state.glowingBrowserCards = {};
    state.glowingAgentCards = {};
    state.persistedExpandedSessionIds = [];
    state.nextZOrder = 1;
    state.initialized = false;
    state.suspendedBrowserCards = keptSuspended;
    state.endingBrowserCards = {};
    state.pendingFocusWorkflowId = null;
  },
};
