import { PayloadAction } from '@reduxjs/toolkit';
import {
  DEFAULT_WORKFLOW_CARD_H,
  DEFAULT_WORKFLOW_CARD_W,
  DEFAULT_WORKFLOWS_HUB_H,
  DEFAULT_WORKFLOWS_HUB_W,
  GRID_GAP,
  WORKFLOW_CARD_GAP,
  type DashboardLayoutState,
  type WorkflowsRunContext,
  WORKFLOWS_HUB_ID
} from './dashboardLayoutModel';
import {
  collectOccupiedRects,
  findOpenGridCell,
  findOpenSpotNear,
} from './dashboardLayoutGeometry';
import { ledgerAdd, ledgerRekey, ledgerRemove } from './dashboardLayoutCardState';

export function closeWorkflowsAppState(state: DashboardLayoutState): void {
  state.workflowsHub = null;
  delete state.tiledCards[WORKFLOWS_HUB_ID];
  delete state.minimizedCards[WORKFLOWS_HUB_ID];
  state.workflowsAppTarget = null;
  state.workflowsMonitorId = null;
  state.workflowsMonitorRunId = null;
  state.workflowsMonitorCard = null;
}

export const workflowCardReducers = {
  addWorkflowCard(
    state: DashboardLayoutState,
    action: PayloadAction<{
      workflowId: string;
      sourceSessionId?: string | null;
      expandedSessionIds?: string[];
    }>,
  ) {
    const { workflowId, sourceSessionId, expandedSessionIds } = action.payload;
    if (state.workflowCards[workflowId]) {
      state.workflowCards[workflowId].zOrder = state.nextZOrder++;
      state.pendingFocusWorkflowId = workflowId;
      return;
    }
    const expanded = expandedSessionIds ?? state.persistedExpandedSessionIds;
    const rects = collectOccupiedRects(state, expanded);
    let posX: number, posY: number;
    const parentCard = sourceSessionId ? state.cards[sourceSessionId] : null;
    if (parentCard) {
      const anchorX = parentCard.x + parentCard.width + GRID_GAP * 6;
      const anchorY = parentCard.y;
      const pos = findOpenSpotNear(anchorX, anchorY, rects, DEFAULT_WORKFLOW_CARD_W, DEFAULT_WORKFLOW_CARD_H);
      posX = pos.x;
      posY = pos.y;
    } else {
      const pos = findOpenGridCell(rects, DEFAULT_WORKFLOW_CARD_W, DEFAULT_WORKFLOW_CARD_H);
      posX = pos.x;
      posY = pos.y;
    }
    state.workflowCards[workflowId] = {
      workflow_id: workflowId,
      x: posX,
      y: posY,
      width: DEFAULT_WORKFLOW_CARD_W,
      height: DEFAULT_WORKFLOW_CARD_H,
      zOrder: state.nextZOrder++,
      source_session_id: sourceSessionId || null,
    };
    ledgerAdd(state.creationOrder, workflowId);
    state.pendingFocusWorkflowId = workflowId;
  },

  setWorkflowCardPosition(
    state: DashboardLayoutState,
    action: PayloadAction<{ workflowId: string; x: number; y: number }>,
  ) {
    const { workflowId, x, y } = action.payload;
    const card = state.workflowCards[workflowId];
    if (card) {
      card.x = x;
      card.y = y;
    }
  },

  setWorkflowCardSize(
    state: DashboardLayoutState,
    action: PayloadAction<{ workflowId: string; width: number; height: number }>,
  ) {
    const { workflowId, width, height } = action.payload;
    const card = state.workflowCards[workflowId];
    if (card) {
      card.width = Math.max(360, width);
      card.height = Math.max(280, height);
    }
  },

  removeWorkflowCard(state: DashboardLayoutState, action: PayloadAction<string>) {
    delete state.workflowCards[action.payload];
    // Rule 7: a dead card must never keep owning a tile; a stale entry poisons every reader of it.
    delete state.tiledCards[action.payload];
    delete state.minimizedCards[action.payload];
    ledgerRemove(state.creationOrder, action.payload);
  },

  rekeyWorkflowCard(
    state: DashboardLayoutState,
    action: PayloadAction<{ oldId: string; newId: string }>,
  ) {
    const { oldId, newId } = action.payload;
    const card = state.workflowCards[oldId];
    if (!card) return;
    delete state.workflowCards[oldId];
    state.workflowCards[newId] = { ...card, workflow_id: newId };
    ledgerRekey(state.creationOrder, oldId, newId);
    if (state.pendingFocusWorkflowId === oldId) state.pendingFocusWorkflowId = newId;
  },

  clearPendingFocusWorkflowId(state: DashboardLayoutState) {
    state.pendingFocusWorkflowId = null;
  },

  openWorkflowsHub(state: DashboardLayoutState, action: PayloadAction<{ expandedSessionIds?: string[] } | undefined>) {
    if (state.workflowsHub) {
      state.workflowsHub.zOrder = state.nextZOrder++;
      delete state.minimizedCards[WORKFLOWS_HUB_ID];
      state.pendingFocusWorkflowsHub = true;
      return;
    }
    const rects = collectOccupiedRects(state, action.payload?.expandedSessionIds);
    const pos = findOpenGridCell(rects, DEFAULT_WORKFLOWS_HUB_W, DEFAULT_WORKFLOWS_HUB_H);
    state.workflowsHub = {
      x: pos.x,
      y: pos.y,
      width: DEFAULT_WORKFLOWS_HUB_W,
      height: DEFAULT_WORKFLOWS_HUB_H,
      zOrder: state.nextZOrder++,
    };
    state.pendingFocusWorkflowsHub = true;
  },

  clearPendingFocusWorkflowsHub(state: DashboardLayoutState) {
    state.pendingFocusWorkflowsHub = false;
  },

  closeWorkflowsHub(state: DashboardLayoutState) {
    state.workflowsHub = null;
    delete state.minimizedCards[WORKFLOWS_HUB_ID];
    delete state.tiledCards[WORKFLOWS_HUB_ID];
  },

  openWorkflowsApp(
    state: DashboardLayoutState,
    action: PayloadAction<{ workflowId?: string; expandedSessionIds?: string[] } | undefined>,
  ) {
    state.workflowsAppTarget = action.payload?.workflowId ?? null;
    if (state.workflowsHub) {
      state.workflowsHub.zOrder = state.nextZOrder++;
      // Opening means visible: a parked window must come back to the canvas, or the focus pan flies to empty space.
      delete state.minimizedCards[WORKFLOWS_HUB_ID];
      state.pendingFocusWorkflowsHub = true;
      return;
    }
    const rects = collectOccupiedRects(state, action.payload?.expandedSessionIds);
    const pos = findOpenGridCell(rects, DEFAULT_WORKFLOWS_HUB_W, DEFAULT_WORKFLOWS_HUB_H);
    state.workflowsHub = {
      x: pos.x,
      y: pos.y,
      width: DEFAULT_WORKFLOWS_HUB_W,
      height: DEFAULT_WORKFLOWS_HUB_H,
      zOrder: state.nextZOrder++,
    };
    state.pendingFocusWorkflowsHub = true;
  },

  closeWorkflowsApp(state: DashboardLayoutState) {
    closeWorkflowsAppState(state);
  },

  clearWorkflowsAppTarget(state: DashboardLayoutState) {
    state.workflowsAppTarget = null;
  },

  openWorkflowMonitor(state: DashboardLayoutState, action: PayloadAction<{ workflowId: string; runId?: string }>) {
    state.workflowsMonitorId = action.payload.workflowId;
    state.workflowsMonitorRunId = action.payload.runId ?? null;
    const hub = state.workflowsHub;
    if (!state.workflowsMonitorCard) {
      state.workflowsMonitorCard = {
        x: hub ? hub.x + hub.width + WORKFLOW_CARD_GAP : 220,
        y: hub ? hub.y : 160,
        width: 520,
        height: hub ? hub.height : 560,
        zOrder: state.nextZOrder++,
      };
    } else {
      state.workflowsMonitorCard.zOrder = state.nextZOrder++;
    }
  },

  closeWorkflowMonitor(state: DashboardLayoutState) {
    state.workflowsMonitorId = null;
    state.workflowsMonitorRunId = null;
    state.workflowsMonitorCard = null;
  },

  setWorkflowsMonitorPosition(state: DashboardLayoutState, action: PayloadAction<{ x: number; y: number }>) {
    if (!state.workflowsMonitorCard) return;
    state.workflowsMonitorCard.x = action.payload.x;
    state.workflowsMonitorCard.y = action.payload.y;
  },

  setWorkflowsRunContext(state: DashboardLayoutState, action: PayloadAction<WorkflowsRunContext>) {
    state.workflowsRunContext = action.payload;
  },

  clearWorkflowsRunContext(state: DashboardLayoutState) {
    state.workflowsRunContext = null;
  },

  setWorkflowsHubPosition(state: DashboardLayoutState, action: PayloadAction<{ x: number; y: number }>) {
    if (!state.workflowsHub) return;
    state.workflowsHub.x = action.payload.x;
    state.workflowsHub.y = action.payload.y;
  },

  setWorkflowsHubSize(state: DashboardLayoutState, action: PayloadAction<{ width: number; height: number }>) {
    if (!state.workflowsHub) return;
    state.workflowsHub.width = Math.max(720, action.payload.width);
    state.workflowsHub.height = Math.max(420, action.payload.height);
  },
};
