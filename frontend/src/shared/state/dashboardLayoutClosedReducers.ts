import { PayloadAction } from '@reduxjs/toolkit';
import {
  RECENTLY_CLOSED_CAP,
  viewCardKey,
  type ClosedCard,
  type ClosedCardKind,
  type DashboardLayoutState,
} from './dashboardLayoutModel';
import { generateTabId } from './dashboardLayoutBrowserReducers';

export const closedCardReducers = {
  recordClosedCard(
    state: DashboardLayoutState,
    action: PayloadAction<{ kind: ClosedCardKind; id: string; browserId?: string }>,
  ) {
    const { kind, id, browserId } = action.payload;
    const closedAt = Date.now();
    const uid = `${kind}-${id}-${closedAt}`;
    let entry: ClosedCard | null = null;
    if (kind === 'browser' && state.browserCards[id]) {
      entry = { uid, kind, closedAt, card: { ...state.browserCards[id], tabs: state.browserCards[id].tabs.map((tab) => ({ ...tab })) } };
    } else if (kind === 'view' && state.viewCards[id]) {
      entry = { uid, kind, closedAt, card: { ...state.viewCards[id] } };
    } else if (kind === 'workflow' && state.workflowCards[id]) {
      entry = { uid, kind, closedAt, card: { ...state.workflowCards[id] } };
    } else if (kind === 'agent') {
      entry = { uid, kind, closedAt, sessionId: id, position: state.cards[id] ? { ...state.cards[id] } : null };
    } else if (kind === 'tab' && browserId && state.browserCards[browserId]) {
      const card = state.browserCards[browserId];
      const index = card.tabs.findIndex((tab) => tab.id === id);
      if (index >= 0 && card.tabs.length > 1) entry = { uid, kind, closedAt, browserId, index, tab: { ...card.tabs[index] } };
    }
    if (!entry) return;
    state.recentlyClosed.push(entry);
    if (state.recentlyClosed.length > RECENTLY_CLOSED_CAP) state.recentlyClosed.shift();
  },

  restoreClosedCard(
    state: DashboardLayoutState,
    action: PayloadAction<{ entry: ClosedCard; dashboardId?: string }>,
  ) {
    const { entry, dashboardId } = action.payload;
    const zOrder = state.nextZOrder++;
    if (entry.kind === 'browser') {
      state.browserCards[entry.card.browser_id] = { ...entry.card, zOrder, dashboard_id: dashboardId ?? entry.card.dashboard_id };
    } else if (entry.kind === 'view') {
      state.viewCards[viewCardKey(entry.card.output_id, entry.card.instance)] = { ...entry.card, zOrder };
    } else if (entry.kind === 'workflow') {
      state.workflowCards[entry.card.workflow_id] = { ...entry.card, zOrder };
    } else if (entry.kind === 'tab') {
      const card = state.browserCards[entry.browserId];
      if (card) {
        const tab = { ...entry.tab, id: generateTabId() };
        card.tabs.splice(Math.min(entry.index, card.tabs.length), 0, tab);
        card.activeTabId = tab.id;
        card.url = tab.url;
      }
    }
  },

  popClosedCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    state.recentlyClosed = state.recentlyClosed.filter((entry) => entry.uid !== action.payload);
  },
};
