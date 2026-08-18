import { PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  type CardPosition,
  type DashboardLayoutState,
} from './dashboardLayoutModel';
import {
  collectOccupiedRects,
  findOpenGridCell,
  findOpenSpotNear,
} from './dashboardLayoutGeometry';
import { ledgerAdd, ledgerRemove } from './dashboardLayoutCardState';

export const agentCardReducers = {
  setCardPosition(
    state: DashboardLayoutState,
    action: PayloadAction<{ sessionId: string; x: number; y: number }>,
  ) {
    const { sessionId, x, y } = action.payload;
    const card = state.cards[sessionId];
    if (card) {
      card.x = x;
      card.y = y;
    }
  },

  setCardSize(
    state: DashboardLayoutState,
    action: PayloadAction<{ sessionId: string; width: number; height: number }>,
  ) {
    const { sessionId, width, height } = action.payload;
    const card = state.cards[sessionId];
    if (card) {
      card.width = Math.max(480, width);
      card.height = Math.max(180, height);
    }
  },

  placeCard(
    state: DashboardLayoutState,
    action: PayloadAction<{
      sessionId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      expandedSessionIds?: string[];
      exact?: boolean;
    }>,
  ) {
    const { sessionId, x, y, width, height, expandedSessionIds, exact } = action.payload;
    const pos = exact ? { x, y } : findOpenSpotNear(x, y, collectOccupiedRects(state, expandedSessionIds), width, height);
    state.cards[sessionId] = {
      session_id: sessionId,
      x: pos.x,
      y: pos.y,
      width,
      height,
      zOrder: state.nextZOrder++,
    };
    ledgerAdd(state.creationOrder, sessionId);
  },

  removeCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.cards[action.payload];
    delete state.tiledCards[action.payload];
    delete state.minimizedCards[action.payload];
    ledgerRemove(state.creationOrder, action.payload);
  },

  reconcileSessions(
    state: DashboardLayoutState,
    action: PayloadAction<{ sessionIds: string[]; expandedSessionIds: string[] }>,
  ) {
    const { sessionIds, expandedSessionIds } = action.payload;
    const liveIds = new Set(sessionIds);

    for (const id of Object.keys(state.cards)) {
      if (!liveIds.has(id)) {
        state.closedCardPositions[id] = { ...state.cards[id] };
        delete state.cards[id];
        // A dead card must never keep owning a tile: an orphaned 'fullscreen' entry hides ALL chrome until reload.
        delete state.tiledCards[id];
        delete state.minimizedCards[id];
        ledgerRemove(state.creationOrder, id);
      }
    }

    const hasDraftCard = Object.keys(state.cards).some((id) => id.startsWith('draft-'));
    const newIds = sessionIds.filter((id) => !state.cards[id]);
    for (const id of newIds) {
      if (hasDraftCard && !id.startsWith('draft-')) continue;
      const savedPos = state.closedCardPositions[id];
      if (savedPos) {
        state.cards[id] = { ...savedPos, session_id: id, zOrder: savedPos.zOrder || state.nextZOrder++ };
        ledgerAdd(state.creationOrder, id);
        delete state.closedCardPositions[id];
      } else {
        const rects = collectOccupiedRects(state, expandedSessionIds);
        const pos = findOpenGridCell(rects, DEFAULT_CARD_W, DEFAULT_CARD_H);
        state.cards[id] = {
          session_id: id,
          x: pos.x,
          y: pos.y,
          width: DEFAULT_CARD_W,
          height: DEFAULT_CARD_H,
          zOrder: state.nextZOrder++,
        };
        ledgerAdd(state.creationOrder, id);
      }
    }
  },

  seedClosedAgentPosition(
    state: DashboardLayoutState,
    action: PayloadAction<{ sessionId: string; position: CardPosition }>,
  ) {
    state.closedCardPositions[action.payload.sessionId] = action.payload.position;
  },

  replaceDraftId(
    state: DashboardLayoutState,
    action: PayloadAction<{ oldId: string; newId: string }>,
  ) {
    const { oldId, newId } = action.payload;
    const card = state.cards[oldId];
    if (card) {
      delete state.cards[oldId];
      state.cards[newId] = { ...card, session_id: newId };
    }
  },
};
