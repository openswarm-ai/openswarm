import { PayloadAction } from '@reduxjs/toolkit';
import { getLastDashboardId } from '@/shared/lastDashboardId';
import {
  DEFAULT_BROWSER_CARD_H,
  DEFAULT_BROWSER_CARD_W,
  type BrowserCardPosition,
  type BrowserTab,
  type DashboardLayoutState,
} from './dashboardLayoutModel';
import {
  collectOccupiedRects,
  findOpenGridCell,
  findOpenSpotNear,
} from './dashboardLayoutGeometry';
import { ledgerAdd, ledgerRemove } from './dashboardLayoutCardState';

export function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const browserCardReducers = {
  addBrowserCard(
    state: DashboardLayoutState,
    action: PayloadAction<{ url: string; expandedSessionIds?: string[]; x?: number; y?: number }>,
  ) {
    const id = `browser-${Date.now().toString(36)}`;
    const tabId = generateTabId();
    const pos = action.payload.x != null && action.payload.y != null
      ? { x: action.payload.x, y: action.payload.y }
      : findOpenGridCell(collectOccupiedRects(state, action.payload.expandedSessionIds), DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
    state.browserCards[id] = {
      browser_id: id,
      url: action.payload.url,
      tabs: [{ id: tabId, url: action.payload.url, title: '' }],
      activeTabId: tabId,
      x: pos.x,
      y: pos.y,
      width: DEFAULT_BROWSER_CARD_W,
      height: DEFAULT_BROWSER_CARD_H,
      zOrder: state.nextZOrder++,
      dashboard_id: getLastDashboardId() ?? undefined,
    };
    ledgerAdd(state.creationOrder, id);
    state.pendingFocusBrowserId = id;
  },

  clearPendingFocusBrowserId(state: DashboardLayoutState) {
    state.pendingFocusBrowserId = null;
  },

  addBrowserCardFromBackend(state: DashboardLayoutState, action: PayloadAction<BrowserCardPosition>) {
    const card = action.payload;
    if (state.browserCards[card.browser_id]) return;
    const width = card.width || DEFAULT_BROWSER_CARD_W;
    const height = card.height || DEFAULT_BROWSER_CARD_H;
    const rects = collectOccupiedRects(state);
    const pos = findOpenSpotNear(card.x, card.y, rects, width, height);
    state.browserCards[card.browser_id] = {
      ...card,
      x: pos.x,
      y: pos.y,
      width,
      height,
      zOrder: card.zOrder || state.nextZOrder++,
      dashboard_id: card.dashboard_id ?? getLastDashboardId() ?? undefined,
    };
    ledgerAdd(state.creationOrder, card.browser_id);
  },

  setBrowserCardPosition(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; x: number; y: number }>,
  ) {
    const { browserId, x, y } = action.payload;
    const card = state.browserCards[browserId];
    if (card) {
      card.x = x;
      card.y = y;
    }
  },

  setBrowserCardSize(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; width: number; height: number }>,
  ) {
    const { browserId, width, height } = action.payload;
    const card = state.browserCards[browserId];
    if (card) {
      card.width = Math.max(400, width);
      card.height = Math.max(300, height);
    }
  },

  removeBrowserCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.browserCards[action.payload];
    delete state.suspendedBrowserCards[action.payload];
    delete state.endingBrowserCards[action.payload];
    delete state.tiledCards[action.payload];
    delete state.minimizedCards[action.payload];
    ledgerRemove(state.creationOrder, action.payload);
  },

  markBrowserCardEnding(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; status: 'completed' | 'error' }>,
  ) {
    if (!state.browserCards[action.payload.browserId]) return;
    state.endingBrowserCards[action.payload.browserId] = {
      status: action.payload.status,
      at: Date.now(),
    };
  },

  cancelBrowserCardEnding(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.endingBrowserCards[action.payload];
  },

  keepBrowserCardOpen(state: DashboardLayoutState, action: PayloadAction<string>) {
    const card = state.browserCards[action.payload];
    if (!card) return;
    card.keep_open = true;
    delete state.endingBrowserCards[action.payload];
  },

  suspendBrowserCard(state: DashboardLayoutState, action: PayloadAction<{ browserId: string; dataUrl: string }>) {
    if (!state.browserCards[action.payload.browserId]) return;
    state.suspendedBrowserCards[action.payload.browserId] = {
      dataUrl: action.payload.dataUrl,
      capturedAt: Date.now(),
    };
  },

  resumeBrowserCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.suspendedBrowserCards[action.payload];
  },

  pasteBrowserCard(
    state: DashboardLayoutState,
    action: PayloadAction<{
      tabs: BrowserTab[]; url: string; expandedSessionIds?: string[];
      id?: string; x?: number; y?: number; width?: number; height?: number;
    }>,
  ) {
    const { x, y, width, height } = action.payload;
    const id = action.payload.id || `browser-${Date.now().toString(36)}`;
    const newTabs = action.payload.tabs.map((tab) => ({
      id: generateTabId(),
      url: tab.url,
      title: '',
      favicon: undefined,
    }));
    const activeTab = newTabs[0];
    let posX: number, posY: number;
    if (x != null && y != null) {
      posX = x;
      posY = y;
    } else {
      const rects = collectOccupiedRects(state, action.payload.expandedSessionIds);
      const pos = findOpenGridCell(rects, DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
      posX = pos.x;
      posY = pos.y;
    }
    state.browserCards[id] = {
      browser_id: id,
      url: activeTab?.url || action.payload.url,
      tabs: newTabs.length > 0 ? newTabs : [{ id: generateTabId(), url: action.payload.url, title: '' }],
      activeTabId: activeTab?.id || generateTabId(),
      x: posX,
      y: posY,
      width: width || DEFAULT_BROWSER_CARD_W,
      height: height || DEFAULT_BROWSER_CARD_H,
      zOrder: state.nextZOrder++,
      dashboard_id: getLastDashboardId() ?? undefined,
    };
  },

  updateBrowserCardUrl(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; url: string }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (card) {
      card.url = action.payload.url;
      const tab = card.tabs.find((candidate) => candidate.id === card.activeTabId);
      if (tab) tab.url = action.payload.url;
    }
  },

  addBrowserTab(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; url: string; makeActive?: boolean }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tabId = generateTabId();
    card.tabs.push({ id: tabId, url: action.payload.url, title: '' });
    if (action.payload.makeActive !== false) {
      card.activeTabId = tabId;
      card.url = action.payload.url;
    }
  },

  removeBrowserTab(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; tabId: string }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const idx = card.tabs.findIndex((tab) => tab.id === action.payload.tabId);
    if (idx === -1) return;
    card.tabs.splice(idx, 1);
    if (card.tabs.length === 0) {
      delete state.browserCards[action.payload.browserId];
      delete state.suspendedBrowserCards[action.payload.browserId];
      return;
    }
    if (card.activeTabId === action.payload.tabId) {
      const newActive = card.tabs[Math.min(idx, card.tabs.length - 1)];
      card.activeTabId = newActive.id;
      card.url = newActive.url;
    }
  },

  setActiveBrowserTab(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; tabId: string }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((candidate) => candidate.id === action.payload.tabId);
    if (tab) {
      card.activeTabId = tab.id;
      card.url = tab.url;
    }
  },

  cycleBrowserTab(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; dir: 1 | -1 }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card || card.tabs.length < 2) return;
    const idx = card.tabs.findIndex((tab) => tab.id === card.activeTabId);
    if (idx === -1) return;
    const tabCount = card.tabs.length;
    const next = card.tabs[(idx + action.payload.dir + tabCount) % tabCount];
    card.activeTabId = next.id;
    card.url = next.url;
  },

  updateBrowserTabUrl(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; tabId: string; url: string }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((candidate) => candidate.id === action.payload.tabId);
    if (tab) {
      tab.url = action.payload.url;
      if (action.payload.tabId === card.activeTabId) {
        card.url = action.payload.url;
      }
    }
  },

  updateBrowserTabTitle(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; tabId: string; title: string }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((candidate) => candidate.id === action.payload.tabId);
    if (tab) tab.title = action.payload.title;
  },

  updateBrowserTabFavicon(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; tabId: string; favicon: string }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const tab = card.tabs.find((candidate) => candidate.id === action.payload.tabId);
    if (tab) tab.favicon = action.payload.favicon;
  },

  reorderBrowserTab(
    state: DashboardLayoutState,
    action: PayloadAction<{ browserId: string; tabId: string; toIndex: number }>,
  ) {
    const card = state.browserCards[action.payload.browserId];
    if (!card) return;
    const fromIdx = card.tabs.findIndex((tab) => tab.id === action.payload.tabId);
    if (fromIdx === -1) return;
    const [tab] = card.tabs.splice(fromIdx, 1);
    card.tabs.splice(Math.max(0, Math.min(action.payload.toIndex, card.tabs.length)), 0, tab);
  },

  moveBrowserTab(
    state: DashboardLayoutState,
    action: PayloadAction<{ fromBrowserId: string; tabId: string; toBrowserId?: string; x?: number; y?: number }>
  ) {
    const { fromBrowserId, tabId, toBrowserId, x, y } = action.payload;
    if (toBrowserId === fromBrowserId) return;
    const source = state.browserCards[fromBrowserId];
    if (!source) return;
    const idx = source.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const target = toBrowserId ? state.browserCards[toBrowserId] : undefined;
    if (toBrowserId && !target) return;
    const [moved] = source.tabs.splice(idx, 1);
    // Fresh id: reusing the old one makes the receiving BrowserCard think the tab is already initialized, so its webview never loads the URL and sits at about:blank.
    const tab = { ...moved, id: generateTabId() };
    const spun = {
      owner: source.spawned_by ?? null,
      x: source.x, y: source.y, width: source.width, height: source.height, dashboard_id: source.dashboard_id,
    };
    const dissolved = source.tabs.length === 0;
    if (dissolved) {
      delete state.browserCards[fromBrowserId];
      delete state.suspendedBrowserCards[fromBrowserId];
    } else if (source.activeTabId === tabId) {
      const nextActive = source.tabs[Math.min(idx, source.tabs.length - 1)];
      source.activeTabId = nextActive.id;
      source.url = nextActive.url;
    }
    if (target) {
      target.tabs.push(tab);
      target.activeTabId = tab.id;
      target.url = tab.url;
      target.zOrder = state.nextZOrder++;
    } else {
      // The last tab leaving is the card MOVING, so it keeps its id; either way it keeps its agent
      // owner, or the agent stops recognising its own browser and spawns a second one next time it
      // browses. keep_open because pulling it out is the user claiming it: the owner finishing must
      // not delete it out from under them, exactly as when it had no owner at all.
      const id = dissolved ? fromBrowserId : `browser-${Date.now().toString(36)}`;
      state.browserCards[id] = {
        browser_id: id,
        url: tab.url,
        tabs: [tab],
        activeTabId: tab.id,
        x: x ?? spun.x + 60,
        y: y ?? spun.y + 60,
        width: spun.width,
        height: spun.height,
        zOrder: state.nextZOrder++,
        dashboard_id: spun.dashboard_id,
        spawned_by: spun.owner,
        keep_open: true,
      };
    }
  },
};
