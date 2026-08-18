import { PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_MARKETPLACE_CARD_H,
  DEFAULT_MARKETPLACE_CARD_W,
  DEFAULT_SETTINGS_CARD_H,
  DEFAULT_SETTINGS_CARD_W,
  MARKETPLACE_CARD_ID,
  SETTINGS_CARD_ID,
  WORKFLOWS_HUB_ID,
  type BrowserCardPosition,
  type DashboardLayoutState,
  type ViewCardPosition,
} from './dashboardLayoutModel';
import { collectOccupiedRects, findOpenGridCell } from './dashboardLayoutGeometry';

// Window-management reducers ported from upstream openswarm-ai (Settings/Marketplace app cards, docking a browser or view inside its chat, tiling to screen zones, the minimize rail, camera focus, and lazy view previews). One module so the composer stays a composer.

export function tileOwnerExists(s: DashboardLayoutState, id: string): boolean {
  return id in s.cards || id in s.viewCards || id in s.browserCards || id in s.workflowCards
    || (id === WORKFLOWS_HUB_ID && !!s.workflowsHub) || (id === SETTINGS_CARD_ID && !!s.settingsCard)
    || (id === MARKETPLACE_CARD_ID && !!s.marketplaceCard);
}

export function clearOtherDocks(state: { browserCards: Record<string, BrowserCardPosition>; viewCards: Record<string, ViewCardPosition> }, sessionId: string, keepBrowserId?: string): void {
  for (const bc of Object.values(state.browserCards)) {
    if (bc.docked_to !== sessionId) continue;
    // The card being (re-)docked must survive its own clear: layout sync re-asserts docks.
    if (bc.browser_id === keepBrowserId) continue;
    // Corpse cleanup happens in WebSocketManager via removeBrowserCardCleanly, NOT here: a bare store delete gets resurrected by the backend layout sync as a free card.
    bc.docked_to = null;
  }
  for (const vc of Object.values(state.viewCards)) {
    if (vc.docked_to === sessionId) vc.docked_to = null;
  }
}

export const windowCardReducers = {
  // First click on a reveal-parked app card: drop the defer so its live preview boots.
  activateViewCardPreview(state: DashboardLayoutState, action: PayloadAction<string>) {
    const card = state.viewCards[action.payload];
    if (card && card.preview_deferred) card.preview_deferred = undefined;
  },

  clearAllTiles(state: DashboardLayoutState) {
    state.tiledCards = {};
  },

  clearCardWindowState(state: DashboardLayoutState, action: PayloadAction<string>) {
    const id = action.payload;
    if (state.minimizedCards[id]) delete state.minimizedCards[id];
    if (state.tiledCards[id]) delete state.tiledCards[id];
  },

  clearMarketplaceRequestedTab(state: DashboardLayoutState) {
    state.marketplaceRequestedTab = null;
  },

  clearPendingFocusMarketplaceCard(state: DashboardLayoutState) {
    state.pendingFocusMarketplaceCard = false;
  },

  clearPendingFocusSettingsCard(state: DashboardLayoutState) {
    state.pendingFocusSettingsCard = false;
  },

  clearSettingsRequestedTab(state: DashboardLayoutState) {
    state.settingsRequestedTab = null;
  },

  clearTiledCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    if (state.tiledCards[action.payload]) delete state.tiledCards[action.payload];
  },

  closeMarketplaceCard(state: DashboardLayoutState) {
    state.marketplaceCard = null;
    state.marketplaceRequestedTab = null;
    delete state.minimizedCards[MARKETPLACE_CARD_ID];
    delete state.tiledCards[MARKETPLACE_CARD_ID];
    state.pendingFocusMarketplaceCard = false;
  },

  closeSettingsCard(state: DashboardLayoutState) {
    state.settingsCard = null;
    state.settingsRequestedTab = null;
    delete state.minimizedCards[SETTINGS_CARD_ID];
    delete state.tiledCards[SETTINGS_CARD_ID];
    state.pendingFocusSettingsCard = false;
  },

  // Camera-focus an EXISTING card (the inline chat embeds' "show on canvas"); the lifecycle
  // pendingFocus effects own the fit + highlight + clear, same as a fresh add.
  focusBrowserCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    if (state.browserCards[action.payload]) state.pendingFocusBrowserId = action.payload;
  },

  focusViewCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    if (state.viewCards[action.payload]) state.pendingFocusViewCardId = action.payload;
  },

  // Marketplace mirrors the Settings window: an on-canvas singleton, opened or raised in place.
  openMarketplaceCard(state: DashboardLayoutState, action: PayloadAction<{ tab?: string; expandedSessionIds?: string[] } | undefined>) {
    state.marketplaceRequestedTab = action.payload?.tab ?? null;
    if (state.marketplaceCard) {
      state.marketplaceCard.zOrder = state.nextZOrder++;
      delete state.minimizedCards[MARKETPLACE_CARD_ID];
      state.pendingFocusMarketplaceCard = true;
      return;
    }
    const rects = collectOccupiedRects(state, action.payload?.expandedSessionIds);
    const pos = findOpenGridCell(rects, DEFAULT_MARKETPLACE_CARD_W, DEFAULT_MARKETPLACE_CARD_H);
    state.marketplaceCard = {
      x: pos.x,
      y: pos.y,
      width: DEFAULT_MARKETPLACE_CARD_W,
      height: DEFAULT_MARKETPLACE_CARD_H,
      zOrder: state.nextZOrder++,
    };
    state.pendingFocusMarketplaceCard = true;
  },

  // Settings is an on-canvas window like the Workflows app, not a modal: opening it creates or raises that card and pans to it.
  openSettingsCard(state: DashboardLayoutState, action: PayloadAction<{ tab?: string; expandedSessionIds?: string[] } | undefined>) {
    state.settingsRequestedTab = action.payload?.tab ?? null;
    if (state.settingsCard) {
      state.settingsCard.zOrder = state.nextZOrder++;
      delete state.minimizedCards[SETTINGS_CARD_ID];
      state.pendingFocusSettingsCard = true;
      return;
    }
    const rects = collectOccupiedRects(state, action.payload?.expandedSessionIds);
    const pos = findOpenGridCell(rects, DEFAULT_SETTINGS_CARD_W, DEFAULT_SETTINGS_CARD_H);
    state.settingsCard = {
      x: pos.x,
      y: pos.y,
      width: DEFAULT_SETTINGS_CARD_W,
      height: DEFAULT_SETTINGS_CARD_H,
      zOrder: state.nextZOrder++,
    };
    state.pendingFocusSettingsCard = true;
  },

  setBrowserDocked(state: DashboardLayoutState, action: PayloadAction<{ browserId: string; dockedTo: string | null }>) {
    const bc = state.browserCards[action.payload.browserId];
    if (!bc) return;
    if (action.payload.dockedTo) clearOtherDocks(state, action.payload.dockedTo, action.payload.browserId);
    bc.docked_to = action.payload.dockedTo;
  },

  setMarketplaceCardPosition(state: DashboardLayoutState, action: PayloadAction<{ x: number; y: number }>) {
    if (!state.marketplaceCard) return;
    state.marketplaceCard.x = action.payload.x;
    state.marketplaceCard.y = action.payload.y;
  },

  setMarketplaceCardSize(state: DashboardLayoutState, action: PayloadAction<{ width: number; height: number }>) {
    if (!state.marketplaceCard) return;
    state.marketplaceCard.width = Math.max(760, action.payload.width);
    state.marketplaceCard.height = Math.max(520, action.payload.height);
  },

  setSettingsCardPosition(state: DashboardLayoutState, action: PayloadAction<{ x: number; y: number }>) {
    if (!state.settingsCard) return;
    state.settingsCard.x = action.payload.x;
    state.settingsCard.y = action.payload.y;
  },

  setSettingsCardSize(state: DashboardLayoutState, action: PayloadAction<{ width: number; height: number }>) {
    if (!state.settingsCard) return;
    state.settingsCard.width = Math.max(640, action.payload.width);
    state.settingsCard.height = Math.max(460, action.payload.height);
  },

  setTiledCard(state: DashboardLayoutState, action: PayloadAction<{ cardId: string; zone: string }>) {
    const { cardId, zone } = action.payload;
    // The rail defers its tile dispatch two frames, so the card can be gone by the time it lands; a stranded 'fullscreen' hides the whole shell.
    if (!tileOwnerExists(state, cardId)) return;
    // One fullscreen owner, ever: two entries would fight over who hides the chrome and who gets the Escape.
    if (zone === 'fullscreen') {
      for (const [id, z] of Object.entries(state.tiledCards)) {
        if (z === 'fullscreen' && id !== cardId) delete state.tiledCards[id];
      }
    }
    state.tiledCards[cardId] = zone;
    if (state.minimizedCards[cardId]) delete state.minimizedCards[cardId];
  },

  setViewDocked(state: DashboardLayoutState, action: PayloadAction<{ cardKey: string; dockedTo: string | null }>) {
    const vc = state.viewCards[action.payload.cardKey];
    if (!vc) return;
    if (action.payload.dockedTo) clearOtherDocks(state, action.payload.dockedTo);
    vc.docked_to = action.payload.dockedTo;
  },

  // Window controls (traffic lights). Minimize parks a card in the right-edge rail; tiling snaps it
  // to a macOS-style viewport zone. Rule 6 of the tiling set (see cards/useCardTiling.ts): a parked
  // card keeps its zone and restores back into it, but never keeps 'fullscreen', which would leave
  // an off-canvas card hiding the whole shell.
  toggleMinimizeCard(state: DashboardLayoutState, action: PayloadAction<{ cardId: string }>) {
    const id = action.payload.cardId;
    if (state.minimizedCards[id]) {
      delete state.minimizedCards[id];
    } else {
      state.minimizedCards[id] = true;
      if (state.tiledCards[id] === 'fullscreen') delete state.tiledCards[id];
    }
  },
};
