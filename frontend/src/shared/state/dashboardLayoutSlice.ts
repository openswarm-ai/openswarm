import { createSlice } from '@reduxjs/toolkit';
import { initialState, generateTabId } from './dashboardLayoutTypes';
import type { CardPosition, ViewCardPosition, BrowserCardPosition } from './dashboardLayoutTypes';
import { dashboardLayoutReducers } from './dashboardLayoutReducers';
import { GET_DASHBOARD } from '@/shared/backend-bridge/apps/dashboards';
import { META_LAUNCH_AND_SEND } from '@/shared/backend-bridge/apps/agents';

const dashboardLayoutSlice = createSlice({
  name: 'dashboardLayout',
  initialState,
  reducers: dashboardLayoutReducers,
  extraReducers: (builder) => {
    builder
      .addCase(GET_DASHBOARD.pending, (state) => {
        state.loading = true;
      })
      .addCase(GET_DASHBOARD.fulfilled, (state, action) => {
        state.loading = false;
        state.initialized = true;
        const layout = action.payload.layout ?? {};
        const browserCards = (layout.browser_cards ?? {}) as Record<string, any>;

        for (const card of Object.values(browserCards)) {
          if (!card.tabs || card.tabs.length === 0) {
            const tabId = generateTabId();
            card.tabs = [{ id: tabId, url: card.url || 'https://www.google.com', title: '' }];
            card.activeTabId = tabId;
          }
          if (!card.url && card.tabs.length > 0) {
            const active = card.tabs.find((t: any) => t.id === card.activeTabId) || card.tabs[0];
            card.url = active.url;
          }
        }

        state.cards = (layout.cards ?? {}) as Record<string, CardPosition>;
        state.viewCards = (layout.view_cards ?? {}) as Record<string, ViewCardPosition>;
        state.browserCards = browserCards as Record<string, BrowserCardPosition>;
        state.persistedExpandedSessionIds = (layout.expanded_session_ids ?? []) as string[];

        let maxZ = 0;
        for (const c of Object.values(state.cards)) {
          if (!c.z_order) c.z_order = 0;
          if (c.z_order > maxZ) maxZ = c.z_order;
        }
        for (const c of Object.values(state.viewCards)) {
          if (!c.z_order) c.z_order = 0;
          if (c.z_order > maxZ) maxZ = c.z_order;
        }
        for (const c of Object.values(state.browserCards)) {
          if (!c.z_order) c.z_order = 0;
          if (c.z_order > maxZ) maxZ = c.z_order;
        }
        state.nextZOrder = maxZ + 1;
      })
      .addCase(GET_DASHBOARD.rejected, (state) => {
        state.loading = false;
        state.initialized = true;
      })
      .addCase(META_LAUNCH_AND_SEND.fulfilled, (state, action) => {
        const { draftId, session } = action.payload;
        const card = state.cards[draftId];
        console.log(`[FRONTEND] dashboardLayout: META_LAUNCH_AND_SEND fulfilled | draftId=${draftId} realId=${session.session_id} draftCardExists=${!!card} allCardKeys=[${Object.keys(state.cards).join(',')}]`);
        if (card) {
          delete state.cards[draftId];
          state.cards[session.session_id] = { ...card, session_id: session.session_id, z_order: state.nextZOrder++ };
          console.log(`[FRONTEND] dashboardLayout: card swapped | ${draftId} → ${session.session_id} | newCardKeys=[${Object.keys(state.cards).join(',')}]`);
        } else {
          console.warn(`[FRONTEND] dashboardLayout: NO CARD FOUND for draftId=${draftId} — card swap SKIPPED`);
        }
      });
  },
});

export const {
  setCardPosition, placeCard, setCardSize, removeCard, bringToFront,
  reconcileSessions, tidyLayout,
  addViewCard, setViewCardPosition, setViewCardSize, removeViewCard,
  addBrowserCard, addBrowserCardFromBackend, setBrowserCardPosition,
  setBrowserCardSize, removeBrowserCard, pasteBrowserCard,
  addBrowserTab, removeBrowserTab,
  setActiveBrowserTab, updateBrowserTabUrl, updateBrowserTabTitle,
  updateBrowserTabFavicon, reorderBrowserTab, moveCards,
  setGlowingBrowserCards, fadeGlowingBrowserCards,
  clearGlowingBrowserCards,
  setGlowingAgentCard, fadeGlowingAgentCard, clearGlowingAgentCard,
  resetLayout,
} = dashboardLayoutSlice.actions;

export default dashboardLayoutSlice.reducer;

export * from './dashboardLayoutTypes';
