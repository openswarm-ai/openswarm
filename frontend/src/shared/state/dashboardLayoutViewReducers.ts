import { PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_VIEW_CARD_H,
  DEFAULT_VIEW_CARD_W,
  viewCardKey,
  type DashboardLayoutState,
} from './dashboardLayoutModel';
import {
  collectOccupiedRects,
  findOpenGridCell,
  placeInParentColumn,
} from './dashboardLayoutGeometry';
import { ledgerAdd, ledgerRemove } from './dashboardLayoutCardState';
import { clearOtherDocks } from './dashboardLayoutWindowReducers';

export const viewCardReducers = {
  addViewCard(
    state: DashboardLayoutState,
    action: PayloadAction<{
      outputId: string; expandedSessionIds?: string[];
      parentSessionId?: string | null;
      x?: number; y?: number; width?: number; height?: number;
      newInstance?: boolean;
      // Reveal-only: start as a light "click to open" card instead of booting the preview eagerly.
      previewDeferred?: boolean;
    }>,
  ) {
    const { outputId, expandedSessionIds, parentSessionId, x, y, width, height, newInstance, previewDeferred } = action.payload;
    let instance = 1;
    if (state.viewCards[outputId]) {
      if (!newInstance) {
        state.viewCards[outputId].zOrder = state.nextZOrder++;
        state.pendingFocusViewCardId = outputId;
        return;
      }
      instance = 2;
      while (state.viewCards[viewCardKey(outputId, instance)]) instance++;
    }
    const w = width || DEFAULT_VIEW_CARD_W;
    const h = height || DEFAULT_VIEW_CARD_H;
    let posX: number, posY: number;
    if (x != null && y != null) {
      posX = x;
      posY = y;
    } else {
      const parentCard = parentSessionId ? state.cards[parentSessionId] : null;
      if (parentCard) {
        const pos = placeInParentColumn(state, parentSessionId, w, h, expandedSessionIds);
        posX = pos.x;
        posY = pos.y;
      } else {
        const rects = collectOccupiedRects(state, expandedSessionIds);
        const pos = findOpenGridCell(rects, w, h);
        posX = pos.x;
        posY = pos.y;
      }
    }
    const cardKey = viewCardKey(outputId, instance);
    state.viewCards[cardKey] = {
      output_id: outputId,
      instance,
      x: posX,
      y: posY,
      width: w,
      height: h,
      zOrder: state.nextZOrder++,
      parent_session_id: parentSessionId || null,
      // An agent-built app defaults to living INSIDE its chat, same as spawned browsers.
      docked_to: (parentSessionId && (clearOtherDocks(state, parentSessionId), parentSessionId)) || null,
      preview_deferred: previewDeferred || undefined,
    };
    state.pendingFocusViewCardId = cardKey;
    ledgerAdd(state.creationOrder, cardKey);
  },

  clearPendingFocusViewCardId(state: DashboardLayoutState) {
    state.pendingFocusViewCardId = null;
  },

  setViewCardPosition(
    state: DashboardLayoutState,
    action: PayloadAction<{ outputId: string; x: number; y: number }>,
  ) {
    const { outputId, x, y } = action.payload;
    const card = state.viewCards[outputId];
    if (card) {
      card.x = x;
      card.y = y;
    }
  },

  setViewCardSize(
    state: DashboardLayoutState,
    action: PayloadAction<{ outputId: string; width: number; height: number }>,
  ) {
    const { outputId, width, height } = action.payload;
    const card = state.viewCards[outputId];
    if (card) {
      card.width = Math.max(320, width);
      card.height = Math.max(200, height);
    }
  },

  removeViewCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.viewCards[action.payload];
    delete state.tiledCards[action.payload];
    delete state.minimizedCards[action.payload];
    ledgerRemove(state.creationOrder, action.payload);
    if (state.activeViewCardId === action.payload) state.activeViewCardId = null;
  },

  setActiveViewCardId(state: DashboardLayoutState, action: PayloadAction<string | null>) {
    state.activeViewCardId = action.payload;
  },
};
