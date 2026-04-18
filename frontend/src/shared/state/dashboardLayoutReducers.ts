import type { PayloadAction } from '@reduxjs/toolkit';
import type {
  BrowserTab, BrowserCardPosition, DashboardLayoutState, Rect,
} from './dashboardLayoutTypes';
import {
  DEFAULT_CARD_W, DEFAULT_CARD_H,
  DEFAULT_VIEW_CARD_W, DEFAULT_VIEW_CARD_H,
  DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H,
  EXPANDED_CARD_MIN_H,
  generateTabId, collectOccupiedRects, findOpenGridCell,
} from './dashboardLayoutTypes';

type S = DashboardLayoutState;

export const dashboardLayoutReducers = {
  setCardPosition(state: S, action: PayloadAction<{ sessionId: string; x: number; y: number }>) {
    const c = state.cards[action.payload.sessionId];
    if (c) { c.x = action.payload.x; c.y = action.payload.y; }
  },
  setCardSize(state: S, action: PayloadAction<{ sessionId: string; width: number; height: number }>) {
    const c = state.cards[action.payload.sessionId];
    if (c) { c.width = Math.max(480, action.payload.width); c.height = Math.max(180, action.payload.height); }
  },
  placeCard(state: S, action: PayloadAction<{ sessionId: string; x: number; y: number; width: number; height: number }>) {
    const { sessionId, x, y, width, height } = action.payload;
    state.cards[sessionId] = { session_id: sessionId, x, y, width, height, z_order: state.nextZOrder++ };
  },
  bringToFront(state: S, action: PayloadAction<{ id: string; type: 'agent' | 'view' | 'browser' }>) {
    const { id, type } = action.payload;
    const z = state.nextZOrder++;
    if (type === 'agent') { const c = state.cards[id]; if (c) c.z_order = z; }
    else if (type === 'view') { const c = state.viewCards[id]; if (c) c.z_order = z; }
    else { const c = state.browserCards[id]; if (c) c.z_order = z; }
  },
  removeCard(state: S, action: PayloadAction<string>) {
    delete state.cards[action.payload];
  },

  reconcileSessions(state: S, action: PayloadAction<{ sessionIds: string[]; expandedSessionIds: string[] }>) {
    const { sessionIds, expandedSessionIds } = action.payload;
    const liveIds = new Set(sessionIds);
    for (const id of Object.keys(state.cards)) {
      if (!liveIds.has(id)) {
        state.closedCardPositions[id] = { ...state.cards[id] };
        delete state.cards[id];
      }
    }
    const hasDraftCard = Object.keys(state.cards).some((id) => id.startsWith('draft-'));
    const newIds = sessionIds.filter((id) => !state.cards[id]);
    for (const id of newIds) {
      if (hasDraftCard && !id.startsWith('draft-')) continue;
      const savedPos = state.closedCardPositions[id];
      if (savedPos) {
        state.cards[id] = { ...savedPos, session_id: id, z_order: savedPos.z_order || state.nextZOrder++ };
        delete state.closedCardPositions[id];
      } else {
        const rects = collectOccupiedRects(state, expandedSessionIds);
        const pos = findOpenGridCell(rects, DEFAULT_CARD_W, DEFAULT_CARD_H);
        state.cards[id] = { session_id: id, ...pos, width: DEFAULT_CARD_W, height: DEFAULT_CARD_H, z_order: state.nextZOrder++ };
      }
    }
  },

  tidyLayout(state: S, action: PayloadAction<{ expandedSessionIds: string[] }>) {
    const expanded = new Set(action.payload.expandedSessionIds);
    const allItems = [
      ...Object.values(state.cards).map((c) => ({ kind: 'agent' as const, id: c.session_id, x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(state.viewCards).map((c) => ({ kind: 'view' as const, id: c.output_id, x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(state.browserCards).map((c) => ({ kind: 'browser' as const, id: c.browser_id, x: c.x, y: c.y, w: c.width, h: c.height })),
    ];
    if (allItems.length === 0) return;
    allItems.sort((a, b) => a.y - b.y || a.x - b.x);
    const placed: Rect[] = [];
    for (const item of allItems) {
      const h = item.kind === 'agent' && expanded.has(item.id) ? Math.max(EXPANDED_CARD_MIN_H, item.h) : item.h;
      const pos = findOpenGridCell(placed, item.w, h);
      placed.push({ ...pos, w: item.w, h });
      if (item.kind === 'agent') { const c = state.cards[item.id]; if (c) { c.x = pos.x; c.y = pos.y; } }
      else if (item.kind === 'view') { const c = state.viewCards[item.id]; if (c) { c.x = pos.x; c.y = pos.y; } }
      else { const c = state.browserCards[item.id]; if (c) { c.x = pos.x; c.y = pos.y; } }
    }
  },

  addViewCard(state: S, action: PayloadAction<{ outputId: string; expandedSessionIds?: string[]; x?: number; y?: number; width?: number; height?: number }>) {
    const { outputId, expandedSessionIds, x, y, width, height } = action.payload;
    if (state.viewCards[outputId]) return;
    let posX: number, posY: number;
    if (x != null && y != null) { posX = x; posY = y; }
    else {
      const pos = findOpenGridCell(collectOccupiedRects(state, expandedSessionIds), DEFAULT_VIEW_CARD_W, DEFAULT_VIEW_CARD_H);
      posX = pos.x; posY = pos.y;
    }
    state.viewCards[outputId] = { output_id: outputId, x: posX, y: posY, width: width || DEFAULT_VIEW_CARD_W, height: height || DEFAULT_VIEW_CARD_H, z_order: state.nextZOrder++ };
  },
  setViewCardPosition(state: S, action: PayloadAction<{ outputId: string; x: number; y: number }>) {
    const c = state.viewCards[action.payload.outputId];
    if (c) { c.x = action.payload.x; c.y = action.payload.y; }
  },
  setViewCardSize(state: S, action: PayloadAction<{ outputId: string; width: number; height: number }>) {
    const c = state.viewCards[action.payload.outputId];
    if (c) { c.width = Math.max(320, action.payload.width); c.height = Math.max(200, action.payload.height); }
  },
  removeViewCard(state: S, action: PayloadAction<string>) { delete state.viewCards[action.payload]; },

  addBrowserCard(state: S, action: PayloadAction<{ url: string; expandedSessionIds?: string[] }>) {
    const id = `browser-${Date.now().toString(36)}`;
    const tabId = generateTabId();
    const pos = findOpenGridCell(collectOccupiedRects(state, action.payload.expandedSessionIds), DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
    state.browserCards[id] = {
      browser_id: id, url: action.payload.url,
      tabs: [{ id: tabId, url: action.payload.url, title: '' }], activeTabId: tabId,
      ...pos, width: DEFAULT_BROWSER_CARD_W, height: DEFAULT_BROWSER_CARD_H, z_order: state.nextZOrder++,
    };
  },
  addBrowserCardFromBackend(state: S, action: PayloadAction<BrowserCardPosition>) {
    const c = action.payload;
    if (state.browserCards[c.browser_id]) return;
    state.browserCards[c.browser_id] = { ...c, width: c.width || DEFAULT_BROWSER_CARD_W, height: c.height || DEFAULT_BROWSER_CARD_H, z_order: c.z_order || state.nextZOrder++ };
  },
  setBrowserCardPosition(state: S, action: PayloadAction<{ browserId: string; x: number; y: number }>) {
    const c = state.browserCards[action.payload.browserId];
    if (c) { c.x = action.payload.x; c.y = action.payload.y; }
  },
  setBrowserCardSize(state: S, action: PayloadAction<{ browserId: string; width: number; height: number }>) {
    const c = state.browserCards[action.payload.browserId];
    if (c) { c.width = Math.max(400, action.payload.width); c.height = Math.max(300, action.payload.height); }
  },
  removeBrowserCard(state: S, action: PayloadAction<string>) { delete state.browserCards[action.payload]; },
  pasteBrowserCard(state: S, action: PayloadAction<{ tabs: BrowserTab[]; url: string; expandedSessionIds?: string[]; id?: string; x?: number; y?: number; width?: number; height?: number }>) {
    const { x, y, width, height } = action.payload;
    const id = action.payload.id || `browser-${Date.now().toString(36)}`;
    const newTabs = action.payload.tabs.map((t) => ({ id: generateTabId(), url: t.url, title: '', favicon: undefined }));
    const activeTab = newTabs[0];
    let posX: number, posY: number;
    if (x != null && y != null) { posX = x; posY = y; }
    else {
      const pos = findOpenGridCell(collectOccupiedRects(state, action.payload.expandedSessionIds), DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
      posX = pos.x; posY = pos.y;
    }
    state.browserCards[id] = {
      browser_id: id, url: activeTab?.url || action.payload.url,
      tabs: newTabs.length > 0 ? newTabs : [{ id: generateTabId(), url: action.payload.url, title: '' }],
      activeTabId: activeTab?.id || generateTabId(),
      x: posX, y: posY, width: width || DEFAULT_BROWSER_CARD_W, height: height || DEFAULT_BROWSER_CARD_H, z_order: state.nextZOrder++,
    };
  },
  updateBrowserCardUrl(state: S, action: PayloadAction<{ browserId: string; url: string }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    card.url = action.payload.url;
    const tab = card.tabs.find((t) => t.id === card.activeTabId);
    if (tab) tab.url = action.payload.url;
  },
  addBrowserTab(state: S, action: PayloadAction<{ browserId: string; url: string; makeActive?: boolean }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tabId = generateTabId();
    card.tabs.push({ id: tabId, url: action.payload.url, title: '' });
    if (action.payload.makeActive !== false) { card.activeTabId = tabId; card.url = action.payload.url; }
  },
  removeBrowserTab(state: S, action: PayloadAction<{ browserId: string; tabId: string }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const idx = card.tabs.findIndex((t) => t.id === action.payload.tabId);
    if (idx === -1) return;
    card.tabs.splice(idx, 1);
    if (card.tabs.length === 0) { delete state.browserCards[action.payload.browserId]; return; }
    if (card.activeTabId === action.payload.tabId) {
      const a = card.tabs[Math.min(idx, card.tabs.length - 1)];
      card.activeTabId = a.id; card.url = a.url;
    }
  },
  setActiveBrowserTab(state: S, action: PayloadAction<{ browserId: string; tabId: string }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((t) => t.id === action.payload.tabId);
    if (tab) { card.activeTabId = tab.id; card.url = tab.url; }
  },
  updateBrowserTabUrl(state: S, action: PayloadAction<{ browserId: string; tabId: string; url: string }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((t) => t.id === action.payload.tabId);
    if (tab) {
      tab.url = action.payload.url;
      if (action.payload.tabId === card.activeTabId) card.url = action.payload.url;
    }
  },
  updateBrowserTabTitle(state: S, action: PayloadAction<{ browserId: string; tabId: string; title: string }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((t) => t.id === action.payload.tabId);
    if (tab) tab.title = action.payload.title;
  },
  updateBrowserTabFavicon(state: S, action: PayloadAction<{ browserId: string; tabId: string; favicon: string }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((t) => t.id === action.payload.tabId);
    if (tab) tab.favicon = action.payload.favicon;
  },
  reorderBrowserTab(state: S, action: PayloadAction<{ browserId: string; tabId: string; toIndex: number }>) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const fromIdx = card.tabs.findIndex((t) => t.id === action.payload.tabId);
    if (fromIdx === -1) return;
    const [tab] = card.tabs.splice(fromIdx, 1);
    card.tabs.splice(Math.max(0, Math.min(action.payload.toIndex, card.tabs.length)), 0, tab);
  },

  moveCards(state: S, action: PayloadAction<{ items: Array<{ id: string; type: 'agent' | 'view' | 'browser' }>; dx: number; dy: number }>) {
    const { items, dx, dy } = action.payload;
    for (const { id, type } of items) {
      if (type === 'agent') { const c = state.cards[id]; if (c) { c.x += dx; c.y += dy; } }
      else if (type === 'view') { const c = state.viewCards[id]; if (c) { c.x += dx; c.y += dy; } }
      else { const c = state.browserCards[id]; if (c) { c.x += dx; c.y += dy; } }
    }
  },
  replaceDraftId(state: S, action: PayloadAction<{ oldId: string; newId: string }>) {
    const { oldId, newId } = action.payload;
    const card = state.cards[oldId];
    if (card) { delete state.cards[oldId]; state.cards[newId] = { ...card, session_id: newId }; }
  },

  setGlowingBrowserCards(state: S, action: PayloadAction<{ browserIds: string[]; sessionId: string; label?: string }>) {
    const { browserIds, sessionId, label } = action.payload;
    for (const id of browserIds) state.glowingBrowserCards[id] = { sourceId: sessionId, fading: false, label };
  },
  fadeGlowingBrowserCards(state: S, action: PayloadAction<string>) {
    for (const e of Object.values(state.glowingBrowserCards)) if (e.sourceId === action.payload) e.fading = true;
  },
  clearGlowingBrowserCards(state: S, action: PayloadAction<string>) {
    for (const [id, e] of Object.entries(state.glowingBrowserCards)) if (e.sourceId === action.payload) delete state.glowingBrowserCards[id];
  },
  clearAllGlowingBrowserCards(state: S) { state.glowingBrowserCards = {}; },
  setGlowingAgentCard(state: S, action: PayloadAction<{ sessionId: string; sourceId: string; sourceYRatio?: number; label?: string }>) {
    const { sessionId, sourceId, sourceYRatio, label } = action.payload;
    state.glowingAgentCards[sessionId] = { sourceId, fading: false, sourceYRatio, label };
  },
  fadeGlowingAgentCard(state: S, action: PayloadAction<string>) {
    const e = state.glowingAgentCards[action.payload]; if (e) e.fading = true;
  },
  clearGlowingAgentCard(state: S, action: PayloadAction<string>) { delete state.glowingAgentCards[action.payload]; },

  resetLayout(state: S) {
    state.cards = {}; state.viewCards = {}; state.browserCards = {};
    state.closedCardPositions = {}; state.glowingBrowserCards = {}; state.glowingAgentCards = {};
    state.persistedExpandedSessionIds = []; state.nextZOrder = 1; state.initialized = false;
  },
};
