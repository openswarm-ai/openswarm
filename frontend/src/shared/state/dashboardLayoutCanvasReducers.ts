import { PayloadAction } from '@reduxjs/toolkit';
import {
  EXPANDED_CARD_MIN_H,
  viewCardKey,
  type CardType,
  type DashboardLayoutState,
  SETTINGS_CARD_ID,
  MARKETPLACE_CARD_ID
} from './dashboardLayoutModel';
import {
  findOpenGridCell,
  type Rect,
  tidyColumnCount
} from './dashboardLayoutGeometry';
import { getDashboardCardState, maxDashboardCardZOrder } from './dashboardLayoutCardState';

export const canvasReducers = {
  bringToFront(
    state: DashboardLayoutState,
    action: PayloadAction<{ id: string; type: CardType }>,
  ) {
    const { id, type } = action.payload;
    // Focus writes ONLY the override map: the old form mutated the card object, which replaced its dict, re-rendered the controller + tethers + dock + minimap, and armed a layout PUT + thumbnail capture on every press. The nextZOrder-1 holder is always the top card, so the already-on-top guard is one compare.
    const base = getDashboardCardState(state, id, type)?.zOrder ?? 0;
    const effective = state.zOrders[id] ?? base;
    // A persisted layout can outrank a stale counter; repair it first so the raise always lands on top and the already-on-top compare below is against the repaired counter.
    state.nextZOrder = Math.max(state.nextZOrder, maxDashboardCardZOrder(state) + 1);
    // Zero is the legacy every-card tie (backend-synced cards arrive without z); never short-circuit on it.
    if (effective > 0 && effective === state.nextZOrder - 1) return;
    state.zOrders[id] = state.nextZOrder++;
  },

  tidyLayout(
    state: DashboardLayoutState,
    action: PayloadAction<{ expandedSessionIds: string[] }>,
  ) {
    const expanded = new Set(action.payload.expandedSessionIds);
    const agentCards = Object.values(state.cards);
    const viewCards = Object.values(state.viewCards);
    const browserCards = Object.values(state.browserCards);
    const workflowCards = Object.values(state.workflowCards);
    const hub = state.workflowsHub;
    const monitor = state.workflowsMonitorCard;
    const settings = state.settingsCard;
    const market = state.marketplaceCard;
    const total = agentCards.length + viewCards.length + browserCards.length + workflowCards.length + (hub ? 1 : 0) + (monitor ? 1 : 0) + (settings ? 1 : 0) + (market ? 1 : 0);
    if (total === 0) return;

    const allItems = [
      ...agentCards.map((card) => ({ kind: 'agent' as const, id: card.session_id, x: card.x, y: card.y, storedW: card.width, storedH: card.height })),
      ...viewCards.map((card) => ({ kind: 'view' as const, id: viewCardKey(card.output_id, card.instance), x: card.x, y: card.y, storedW: card.width, storedH: card.height })),
      ...browserCards.map((card) => ({ kind: 'browser' as const, id: card.browser_id, x: card.x, y: card.y, storedW: card.width, storedH: card.height })),
      ...workflowCards.map((card) => ({ kind: 'workflow' as const, id: card.workflow_id, x: card.x, y: card.y, storedW: card.width, storedH: card.height })),
      ...(hub ? [{ kind: 'workflows-hub' as const, id: 'workflows-hub', x: hub.x, y: hub.y, storedW: hub.width, storedH: hub.height }] : []),
      ...(monitor ? [{ kind: 'workflows-monitor' as const, id: 'workflows-monitor', x: monitor.x, y: monitor.y, storedW: monitor.width, storedH: monitor.height }] : []),
      ...(settings ? [{ kind: 'settings' as const, id: SETTINGS_CARD_ID, x: settings.x, y: settings.y, storedW: settings.width, storedH: settings.height }] : []),
      ...(market ? [{ kind: 'marketplace' as const, id: MARKETPLACE_CARD_ID, x: market.x, y: market.y, storedW: market.width, storedH: market.height }] : []),
    ];
    allItems.sort((a, b) => a.y - b.y || a.x - b.x);

    const sizeOf = (item: typeof allItems[number]): { w: number; h: number } => ({
      w: item.storedW,
      h: item.kind === 'agent' && expanded.has(item.id)
        ? Math.max(EXPANDED_CARD_MIN_H, item.storedH)
        : item.storedH,
    });
    // Pack into the grid shape that fills the SCREEN best, not the 2-wide ribbon window.innerWidth-as-world-units produced.
    const cols = tidyColumnCount(allItems.map(sizeOf));
    const placedRects: Rect[] = [];

    for (const item of allItems) {
      const { w: width, h: height } = sizeOf(item);

      const pos = findOpenGridCell(placedRects, width, height, cols);
      placedRects.push({ x: pos.x, y: pos.y, w: width, h: height });

      if (item.kind === 'agent') {
        const card = state.cards[item.id];
        if (card) {
          card.x = pos.x;
          card.y = pos.y;
        }
      } else if (item.kind === 'view') {
        const card = state.viewCards[item.id];
        if (card) {
          card.x = pos.x;
          card.y = pos.y;
        }
      } else if (item.kind === 'workflow') {
        const card = state.workflowCards[item.id];
        if (card) {
          card.x = pos.x;
          card.y = pos.y;
        }
      } else if (item.kind === 'workflows-hub') {
        if (state.workflowsHub) {
          state.workflowsHub.x = pos.x;
          state.workflowsHub.y = pos.y;
        }
      } else if (item.kind === 'workflows-monitor') {
        if (state.workflowsMonitorCard) {
          state.workflowsMonitorCard.x = pos.x;
          state.workflowsMonitorCard.y = pos.y;
        }
      } else if (item.kind === 'settings') {
        if (state.settingsCard) {
          state.settingsCard.x = pos.x;
          state.settingsCard.y = pos.y;
        }
      } else if (item.kind === 'marketplace') {
        if (state.marketplaceCard) {
          state.marketplaceCard.x = pos.x;
          state.marketplaceCard.y = pos.y;
        }
      } else {
        const card = state.browserCards[item.id];
        if (card) {
          card.x = pos.x;
          card.y = pos.y;
        }
      }
    }
  },

  moveCards(
    state: DashboardLayoutState,
    action: PayloadAction<{
      items: Array<{ id: string; type: CardType }>;
      dx: number;
      dy: number;
    }>,
  ) {
    const { items, dx, dy } = action.payload;
    for (const item of items) {
      if (item.type === 'agent') {
        const card = state.cards[item.id];
        if (card) {
          card.x += dx;
          card.y += dy;
        }
      } else if (item.type === 'view') {
        const card = state.viewCards[item.id];
        if (card) {
          card.x += dx;
          card.y += dy;
        }
      } else if (item.type === 'workflow') {
        const card = state.workflowCards[item.id];
        if (card) {
          card.x += dx;
          card.y += dy;
        }
      } else if (item.type === 'settings') {
        if (state.settingsCard) {
          state.settingsCard.x += dx;
          state.settingsCard.y += dy;
        }
      } else if (item.type === 'marketplace') {
        if (state.marketplaceCard) {
          state.marketplaceCard.x += dx;
          state.marketplaceCard.y += dy;
        }
      } else if (item.type === 'workflows-hub') {
        if (state.workflowsHub) {
          state.workflowsHub.x += dx;
          state.workflowsHub.y += dy;
        }
      } else {
        const card = state.browserCards[item.id];
        if (card) {
          card.x += dx;
          card.y += dy;
        }
      }
    }
  },
};
