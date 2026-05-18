import { createSlice, createAsyncThunk, PayloadAction, createAction } from '@reduxjs/toolkit';
import { launchAndSendFirstMessage } from './agentsSlice';
import { API_BASE } from '@/shared/config';

// fetchSession 404/410 strips the layout card to stop AgentChat remount-loop. Matched by string to avoid circular import.
const fetchSessionRejectedAction = createAction<
  { sessionId?: string; status?: number } | undefined
>('agents/fetchSession/rejected');

// Cascade workflow delete to layout so the "Make workflow" tether stops pointing at empty space.
const deleteWorkflowFulfilledAction = createAction<string>('workflows/delete/fulfilled');

const DASHBOARDS_API = `${API_BASE}/dashboards`;

export const DEFAULT_CARD_W = 480;
export const DEFAULT_CARD_H = 280;
export const DEFAULT_VIEW_CARD_W = 1280;
export const DEFAULT_VIEW_CARD_H = 800;
export const DEFAULT_BROWSER_CARD_W = 1280;
export const DEFAULT_BROWSER_CARD_H = 800;
export const DEFAULT_WORKFLOW_CARD_W = 440;
export const DEFAULT_WORKFLOW_CARD_H = 520;
export const DEFAULT_WORKFLOWS_HUB_W = 1200;
export const DEFAULT_WORKFLOWS_HUB_H = 640;
export const EXPANDED_CARD_MIN_H = 620;
export const GRID_GAP = 24;
const GRID_ORIGIN = { x: 40, y: 100 };
const GRID_COLS_FALLBACK = 4;

export interface CardPosition {
  session_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

export interface ViewCardPosition {
  output_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
}

export interface BrowserCardPosition {
  browser_id: string;
  url: string;
  tabs: BrowserTab[];
  activeTabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  /** Agent session that spawned this browser; auto-removed when its owner reaches terminal state. */
  spawned_by?: string | null;
}

export interface WorkflowCardPosition {
  workflow_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  source_session_id?: string | null;
}

/** Singleton per dashboard; only one Workflows Hub card open at a time. */
export interface WorkflowsHubPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'gray';

export interface NotePosition {
  note_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  color: NoteColor;
  zOrder: number;
}

export const DEFAULT_NOTE_W = 240;
export const DEFAULT_NOTE_H = 200;

export interface DashboardLayoutState {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  notes: Record<string, NotePosition>;
  closedCardPositions: Record<string, CardPosition>;
  glowingBrowserCards: Record<string, { sourceId: string; fading: boolean; label?: string }>;
  glowingAgentCards: Record<string, { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string }>;
  persistedExpandedSessionIds: string[];
  nextZOrder: number;
  loading: boolean;
  initialized: boolean;
  /** Transient: new browser card id; Dashboard pans/zooms to it then clears via clearPendingFocusBrowserId. */
  pendingFocusBrowserId: string | null;
  pendingFocusNoteId: string | null;
  pendingFocusWorkflowId: string | null;
  /** Transient: signals Dashboard to pan/zoom to the singleton Workflows Hub on open. */
  pendingFocusWorkflowsHub: boolean;
}

const initialState: DashboardLayoutState = {
  cards: {},
  viewCards: {},
  browserCards: {},
  workflowCards: {},
  workflowsHub: null,
  notes: {},
  closedCardPositions: {},
  glowingBrowserCards: {},
  glowingAgentCards: {},
  persistedExpandedSessionIds: [],
  nextZOrder: 1,
  loading: false,
  initialized: false,
  pendingFocusBrowserId: null,
  pendingFocusNoteId: null,
  pendingFocusWorkflowId: null,
  pendingFocusWorkflowsHub: false,
};

interface LayoutPayload {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  notes: Record<string, NotePosition>;
  expandedSessionIds: string[];
}

function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const fetchLayout = createAsyncThunk(
  'dashboardLayout/fetch',
  async (dashboardId: string) => {
    const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`);
    const data = await res.json();
    const layout = data.layout ?? {};
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

    return {
      cards: (layout.cards ?? {}) as Record<string, CardPosition>,
      viewCards: (layout.view_cards ?? {}) as Record<string, ViewCardPosition>,
      browserCards: browserCards as Record<string, BrowserCardPosition>,
      workflowCards: (layout.workflow_cards ?? {}) as Record<string, WorkflowCardPosition>,
      workflowsHub: (layout.workflows_hub ?? null) as WorkflowsHubPosition | null,
      notes: (layout.notes ?? {}) as Record<string, NotePosition>,
      expandedSessionIds: (layout.expanded_session_ids ?? []) as string[],
    } satisfies LayoutPayload;
  },
);

interface SaveLayoutPayload extends LayoutPayload {
  dashboardId: string;
}

export const saveLayout = createAsyncThunk(
  'dashboardLayout/save',
  async (payload: SaveLayoutPayload) => {
    await fetch(`${DASHBOARDS_API}/${payload.dashboardId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: {
          cards: payload.cards,
          view_cards: payload.viewCards,
          browser_cards: payload.browserCards,
          workflow_cards: payload.workflowCards,
          workflows_hub: payload.workflowsHub,
          notes: payload.notes,
          expanded_session_ids: payload.expandedSessionIds,
        },
      }),
    });
    return payload;
  },
);

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function collectOccupiedRects(
  state: DashboardLayoutState,
  expandedSessionIds?: string[],
): Rect[] {
  const expanded = new Set(expandedSessionIds);
  const rects: Rect[] = [];
  for (const c of Object.values(state.cards)) {
    const h = expanded.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height;
    rects.push({ x: c.x, y: c.y, w: c.width, h });
  }
  for (const c of Object.values(state.viewCards)) {
    rects.push({ x: c.x, y: c.y, w: c.width, h: c.height });
  }
  for (const c of Object.values(state.browserCards)) {
    rects.push({ x: c.x, y: c.y, w: c.width, h: c.height });
  }
  for (const w of Object.values(state.workflowCards)) {
    rects.push({ x: w.x, y: w.y, w: w.width, h: w.height });
  }
  if (state.workflowsHub) {
    rects.push({ x: state.workflowsHub.x, y: state.workflowsHub.y, w: state.workflowsHub.width, h: state.workflowsHub.height });
  }
  for (const n of Object.values(state.notes)) {
    rects.push({ x: n.x, y: n.y, w: n.width, h: n.height });
  }
  return rects;
}

export function findOpenGridCell(
  occupiedRects: Rect[],
  newW: number,
  newH: number,
): { x: number; y: number } {
  const cellW = DEFAULT_CARD_W + GRID_GAP;
  const cellH = DEFAULT_CARD_H + GRID_GAP;
  const maxCols = Math.max(
    1,
    Math.floor((window.innerWidth - GRID_ORIGIN.x) / cellW) || GRID_COLS_FALLBACK,
  );

  for (let row = 0; ; row++) {
    for (let col = 0; col < maxCols; col++) {
      const x = GRID_ORIGIN.x + col * cellW;
      const y = GRID_ORIGIN.y + row * cellH;
      const candidate: Rect = { x, y, w: newW, h: newH };
      if (!occupiedRects.some((r) => rectsOverlap(candidate, r))) {
        return { x, y };
      }
    }
  }
}

/** findOpenGridCell variant biased toward an (x,y) anchor; spiral search capped at ring=32. */
export function findOpenSpotNear(
  anchorX: number,
  anchorY: number,
  occupiedRects: Rect[],
  newW: number,
  newH: number,
): { x: number; y: number } {
  const cellW = DEFAULT_CARD_W + GRID_GAP;
  const cellH = DEFAULT_CARD_H + GRID_GAP;
  // Snap the anchor to the nearest grid cell so cards align.
  const baseCol = Math.round((anchorX - GRID_ORIGIN.x) / cellW);
  const baseRow = Math.round((anchorY - GRID_ORIGIN.y) / cellH);

  const cellFree = (col: number, row: number): boolean => {
    const x = GRID_ORIGIN.x + col * cellW;
    const y = GRID_ORIGIN.y + row * cellH;
    const candidate: Rect = { x, y, w: newW, h: newH };
    return !occupiedRects.some((r) => rectsOverlap(candidate, r));
  };

  if (cellFree(baseCol, baseRow)) {
    return {
      x: GRID_ORIGIN.x + baseCol * cellW,
      y: GRID_ORIGIN.y + baseRow * cellH,
    };
  }

  // Spiral by ring perimeter; right/down preference for stability.
  const MAX_RING = 32;
  for (let r = 1; r <= MAX_RING; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const col = baseCol + dx;
        const row = baseRow + dy;
        if (col < 0 || row < 0) continue;
        if (cellFree(col, row)) {
          return {
            x: GRID_ORIGIN.x + col * cellW,
            y: GRID_ORIGIN.y + row * cellH,
          };
        }
      }
    }
  }

  return findOpenGridCell(occupiedRects, newW, newH);
}

const dashboardLayoutSlice = createSlice({
  name: 'dashboardLayout',
  initialState,
  reducers: {
    setCardPosition(
      state,
      action: PayloadAction<{ sessionId: string; x: number; y: number }>
    ) {
      const { sessionId, x, y } = action.payload;
      const card = state.cards[sessionId];
      if (card) {
        card.x = x;
        card.y = y;
      }
    },

    setCardSize(
      state,
      action: PayloadAction<{ sessionId: string; width: number; height: number }>
    ) {
      const { sessionId, width, height } = action.payload;
      const card = state.cards[sessionId];
      if (card) {
        card.width = Math.max(480, width);
        card.height = Math.max(180, height);
      }
    },

    placeCard(
      state,
      action: PayloadAction<{
        sessionId: string;
        x: number;
        y: number;
        width: number;
        height: number;
        /** Currently-expanded sessions; collision math uses rendered (not stored) heights. */
        expandedSessionIds?: string[];
      }>
    ) {
      const { sessionId, x, y, width, height, expandedSessionIds } = action.payload;
      const rects = collectOccupiedRects(state, expandedSessionIds);
      const pos = findOpenSpotNear(x, y, rects, width, height);
      state.cards[sessionId] = {
        session_id: sessionId,
        x: pos.x,
        y: pos.y,
        width,
        height,
        zOrder: state.nextZOrder++,
      };
    },

    bringToFront(
      state,
      action: PayloadAction<{ id: string; type: 'agent' | 'view' | 'browser' | 'note' | 'workflow' | 'workflows-hub' }>,
    ) {
      const { id, type } = action.payload;
      const z = state.nextZOrder++;
      if (type === 'agent') {
        const card = state.cards[id];
        if (card) card.zOrder = z;
      } else if (type === 'view') {
        const card = state.viewCards[id];
        if (card) card.zOrder = z;
      } else if (type === 'note') {
        const note = state.notes[id];
        if (note) note.zOrder = z;
      } else if (type === 'workflow') {
        const card = state.workflowCards[id];
        if (card) card.zOrder = z;
      } else if (type === 'workflows-hub') {
        if (state.workflowsHub) state.workflowsHub.zOrder = z;
      } else {
        const card = state.browserCards[id];
        if (card) card.zOrder = z;
      }
    },

    removeCard(state, action: PayloadAction<string>) {
      delete state.cards[action.payload];
    },

    reconcileSessions(
      state,
      action: PayloadAction<{ sessionIds: string[]; expandedSessionIds: string[] }>,
    ) {
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
          state.cards[id] = { ...savedPos, session_id: id, zOrder: savedPos.zOrder || state.nextZOrder++ };
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
        }
      }
    },

    tidyLayout(
      state,
      action: PayloadAction<{ expandedSessionIds: string[] }>,
    ) {
      const expanded = new Set(action.payload.expandedSessionIds);
      const agentCards = Object.values(state.cards);
      const viewCards = Object.values(state.viewCards);
      const bCards = Object.values(state.browserCards);
      const wCards = Object.values(state.workflowCards);
      const total = agentCards.length + viewCards.length + bCards.length + wCards.length;
      if (total === 0) return;

      const allItems = [
        ...agentCards.map((c) => ({ kind: 'agent' as const, id: c.session_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...viewCards.map((c) => ({ kind: 'view' as const, id: c.output_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...bCards.map((c) => ({ kind: 'browser' as const, id: c.browser_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...wCards.map((c) => ({ kind: 'workflow' as const, id: c.workflow_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
      ];
      allItems.sort((a, b) => a.y - b.y || a.x - b.x);

      const placedRects: Rect[] = [];

      for (const item of allItems) {
        let w: number, h: number;
        if (item.kind === 'agent') {
          w = item.storedW;
          h = expanded.has(item.id) ? Math.max(EXPANDED_CARD_MIN_H, item.storedH) : item.storedH;
        } else {
          w = item.storedW;
          h = item.storedH;
        }

        const pos = findOpenGridCell(placedRects, w, h);
        placedRects.push({ x: pos.x, y: pos.y, w, h });

        if (item.kind === 'agent') {
          const card = state.cards[item.id];
          if (card) { card.x = pos.x; card.y = pos.y; }
        } else if (item.kind === 'view') {
          const card = state.viewCards[item.id];
          if (card) { card.x = pos.x; card.y = pos.y; }
        } else if (item.kind === 'workflow') {
          const card = state.workflowCards[item.id];
          if (card) { card.x = pos.x; card.y = pos.y; }
        } else {
          const card = state.browserCards[item.id];
          if (card) { card.x = pos.x; card.y = pos.y; }
        }
      }
    },

    addViewCard(state, action: PayloadAction<{
      outputId: string; expandedSessionIds?: string[];
      x?: number; y?: number; width?: number; height?: number;
    }>) {
      const { outputId, expandedSessionIds, x, y, width, height } = action.payload;
      if (state.viewCards[outputId]) return;
      let posX: number, posY: number;
      if (x != null && y != null) {
        posX = x;
        posY = y;
      } else {
        const rects = collectOccupiedRects(state, expandedSessionIds);
        const pos = findOpenGridCell(rects, DEFAULT_VIEW_CARD_W, DEFAULT_VIEW_CARD_H);
        posX = pos.x;
        posY = pos.y;
      }
      state.viewCards[outputId] = {
        output_id: outputId,
        x: posX,
        y: posY,
        width: width || DEFAULT_VIEW_CARD_W,
        height: height || DEFAULT_VIEW_CARD_H,
        zOrder: state.nextZOrder++,
      };
    },

    setViewCardPosition(
      state,
      action: PayloadAction<{ outputId: string; x: number; y: number }>
    ) {
      const { outputId, x, y } = action.payload;
      const card = state.viewCards[outputId];
      if (card) { card.x = x; card.y = y; }
    },

    setViewCardSize(
      state,
      action: PayloadAction<{ outputId: string; width: number; height: number }>
    ) {
      const { outputId, width, height } = action.payload;
      const card = state.viewCards[outputId];
      if (card) {
        card.width = Math.max(320, width);
        card.height = Math.max(200, height);
      }
    },

    removeViewCard(state, action: PayloadAction<string>) {
      delete state.viewCards[action.payload];
    },

    addBrowserCard(state, action: PayloadAction<{ url: string; expandedSessionIds?: string[] }>) {
      const id = `browser-${Date.now().toString(36)}`;
      const tabId = generateTabId();
      const rects = collectOccupiedRects(state, action.payload.expandedSessionIds);
      const pos = findOpenGridCell(rects, DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
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
      };
      state.pendingFocusBrowserId = id;
    },

    clearPendingFocusBrowserId(state) {
      state.pendingFocusBrowserId = null;
    },

    addBrowserCardFromBackend(state, action: PayloadAction<BrowserCardPosition>) {
      const card = action.payload;
      if (state.browserCards[card.browser_id]) return;
      const w = card.width || DEFAULT_BROWSER_CARD_W;
      const h = card.height || DEFAULT_BROWSER_CARD_H;
      // Resolve collisions while biasing toward the proposed position so the spawn looks related.
      const rects = collectOccupiedRects(state);
      const pos = findOpenSpotNear(card.x, card.y, rects, w, h);
      state.browserCards[card.browser_id] = {
        ...card,
        x: pos.x,
        y: pos.y,
        width: w,
        height: h,
        zOrder: card.zOrder || state.nextZOrder++,
      };
    },

    setBrowserCardPosition(
      state,
      action: PayloadAction<{ browserId: string; x: number; y: number }>
    ) {
      const { browserId, x, y } = action.payload;
      const card = state.browserCards[browserId];
      if (card) { card.x = x; card.y = y; }
    },

    setBrowserCardSize(
      state,
      action: PayloadAction<{ browserId: string; width: number; height: number }>
    ) {
      const { browserId, width, height } = action.payload;
      const card = state.browserCards[browserId];
      if (card) {
        card.width = Math.max(400, width);
        card.height = Math.max(300, height);
      }
    },

    removeBrowserCard(state, action: PayloadAction<string>) {
      delete state.browserCards[action.payload];
    },

    addWorkflowCard(
      state,
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
      const rects = collectOccupiedRects(state, expandedSessionIds);
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
      state.pendingFocusWorkflowId = workflowId;
    },

    setWorkflowCardPosition(
      state,
      action: PayloadAction<{ workflowId: string; x: number; y: number }>,
    ) {
      const { workflowId, x, y } = action.payload;
      const card = state.workflowCards[workflowId];
      if (card) { card.x = x; card.y = y; }
    },

    setWorkflowCardSize(
      state,
      action: PayloadAction<{ workflowId: string; width: number; height: number }>,
    ) {
      const { workflowId, width, height } = action.payload;
      const card = state.workflowCards[workflowId];
      if (card) {
        card.width = Math.max(360, width);
        card.height = Math.max(280, height);
      }
    },

    removeWorkflowCard(state, action: PayloadAction<string>) {
      delete state.workflowCards[action.payload];
    },

    // Rekey draft- id to the server-assigned id without visually hopping the card.
    rekeyWorkflowCard(
      state,
      action: PayloadAction<{ oldId: string; newId: string }>,
    ) {
      const { oldId, newId } = action.payload;
      const card = state.workflowCards[oldId];
      if (!card) return;
      delete state.workflowCards[oldId];
      state.workflowCards[newId] = { ...card, workflow_id: newId };
      if (state.pendingFocusWorkflowId === oldId) state.pendingFocusWorkflowId = newId;
    },

    clearPendingFocusWorkflowId(state) {
      state.pendingFocusWorkflowId = null;
    },

    openWorkflowsHub(state, action: PayloadAction<{ expandedSessionIds?: string[] } | undefined>) {
      if (state.workflowsHub) {
        state.workflowsHub.zOrder = state.nextZOrder++;
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

    clearPendingFocusWorkflowsHub(state) {
      state.pendingFocusWorkflowsHub = false;
    },

    closeWorkflowsHub(state) {
      state.workflowsHub = null;
    },

    setWorkflowsHubPosition(state, action: PayloadAction<{ x: number; y: number }>) {
      if (!state.workflowsHub) return;
      state.workflowsHub.x = action.payload.x;
      state.workflowsHub.y = action.payload.y;
    },

    setWorkflowsHubSize(state, action: PayloadAction<{ width: number; height: number }>) {
      if (!state.workflowsHub) return;
      state.workflowsHub.width = Math.max(720, action.payload.width);
      state.workflowsHub.height = Math.max(420, action.payload.height);
    },

    pasteBrowserCard(
      state,
      action: PayloadAction<{
        tabs: BrowserTab[]; url: string; expandedSessionIds?: string[];
        id?: string; x?: number; y?: number; width?: number; height?: number;
      }>
    ) {
      const { x, y, width, height } = action.payload;
      const id = action.payload.id || `browser-${Date.now().toString(36)}`;
      const newTabs = action.payload.tabs.map((t) => ({
        id: generateTabId(),
        url: t.url,
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
      };
    },

    updateBrowserCardUrl(
      state,
      action: PayloadAction<{ browserId: string; url: string }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (card) {
        card.url = action.payload.url;
        const tab = card.tabs.find((t) => t.id === card.activeTabId);
        if (tab) tab.url = action.payload.url;
      }
    },

    addBrowserTab(
      state,
      action: PayloadAction<{ browserId: string; url: string; makeActive?: boolean }>
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
      state,
      action: PayloadAction<{ browserId: string; tabId: string }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card) return;
      const idx = card.tabs.findIndex((t) => t.id === action.payload.tabId);
      if (idx === -1) return;
      card.tabs.splice(idx, 1);
      if (card.tabs.length === 0) {
        delete state.browserCards[action.payload.browserId];
        return;
      }
      if (card.activeTabId === action.payload.tabId) {
        const newActive = card.tabs[Math.min(idx, card.tabs.length - 1)];
        card.activeTabId = newActive.id;
        card.url = newActive.url;
      }
    },

    setActiveBrowserTab(
      state,
      action: PayloadAction<{ browserId: string; tabId: string }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card) return;
      const tab = card.tabs.find((t) => t.id === action.payload.tabId);
      if (tab) {
        card.activeTabId = tab.id;
        card.url = tab.url;
      }
    },

    updateBrowserTabUrl(
      state,
      action: PayloadAction<{ browserId: string; tabId: string; url: string }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card) return;
      const tab = card.tabs.find((t) => t.id === action.payload.tabId);
      if (tab) {
        tab.url = action.payload.url;
        if (action.payload.tabId === card.activeTabId) {
          card.url = action.payload.url;
        }
      }
    },

    updateBrowserTabTitle(
      state,
      action: PayloadAction<{ browserId: string; tabId: string; title: string }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card) return;
      const tab = card.tabs.find((t) => t.id === action.payload.tabId);
      if (tab) tab.title = action.payload.title;
    },

    updateBrowserTabFavicon(
      state,
      action: PayloadAction<{ browserId: string; tabId: string; favicon: string }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card) return;
      const tab = card.tabs.find((t) => t.id === action.payload.tabId);
      if (tab) tab.favicon = action.payload.favicon;
    },

    reorderBrowserTab(
      state,
      action: PayloadAction<{ browserId: string; tabId: string; toIndex: number }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card) return;
      const fromIdx = card.tabs.findIndex((t) => t.id === action.payload.tabId);
      if (fromIdx === -1) return;
      const [tab] = card.tabs.splice(fromIdx, 1);
      card.tabs.splice(Math.max(0, Math.min(action.payload.toIndex, card.tabs.length)), 0, tab);
    },

    moveCards(
      state,
      action: PayloadAction<{
        items: Array<{ id: string; type: 'agent' | 'view' | 'browser' | 'note' | 'workflow' }>;
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
        } else if (item.type === 'note') {
          const note = state.notes[item.id];
          if (note) {
            note.x += dx;
            note.y += dy;
          }
        } else if (item.type === 'workflow') {
          const card = state.workflowCards[item.id];
          if (card) {
            card.x += dx;
            card.y += dy;
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

    addNote(
      state,
      action: PayloadAction<{ x?: number; y?: number; expandedSessionIds?: string[]; color?: NoteColor }>,
    ) {
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      let posX: number, posY: number;
      if (action.payload.x != null && action.payload.y != null) {
        posX = action.payload.x;
        posY = action.payload.y;
      } else {
        const rects = collectOccupiedRects(state, action.payload.expandedSessionIds);
        const pos = findOpenGridCell(rects, DEFAULT_NOTE_W, DEFAULT_NOTE_H);
        posX = pos.x;
        posY = pos.y;
      }
      state.notes[id] = {
        note_id: id,
        x: posX,
        y: posY,
        width: DEFAULT_NOTE_W,
        height: DEFAULT_NOTE_H,
        content: '',
        color: action.payload.color || 'yellow',
        zOrder: state.nextZOrder++,
      };
      state.pendingFocusNoteId = id;
    },

    setNotePosition(state, action: PayloadAction<{ noteId: string; x: number; y: number }>) {
      const n = state.notes[action.payload.noteId];
      if (n) { n.x = action.payload.x; n.y = action.payload.y; }
    },

    setNoteSize(state, action: PayloadAction<{ noteId: string; width: number; height: number }>) {
      const n = state.notes[action.payload.noteId];
      if (n) {
        n.width = Math.max(160, action.payload.width);
        n.height = Math.max(120, action.payload.height);
      }
    },

    updateNoteContent(state, action: PayloadAction<{ noteId: string; content: string }>) {
      const n = state.notes[action.payload.noteId];
      if (n) n.content = action.payload.content;
    },

    setNoteColor(state, action: PayloadAction<{ noteId: string; color: NoteColor }>) {
      const n = state.notes[action.payload.noteId];
      if (n) n.color = action.payload.color;
    },

    removeNote(state, action: PayloadAction<string>) {
      delete state.notes[action.payload];
    },

    clearPendingFocusNoteId(state) {
      state.pendingFocusNoteId = null;
    },

    replaceDraftId(
      state,
      action: PayloadAction<{ oldId: string; newId: string }>
    ) {
      const { oldId, newId } = action.payload;
      const card = state.cards[oldId];
      if (card) {
        delete state.cards[oldId];
        state.cards[newId] = { ...card, session_id: newId };
      }
    },

    setGlowingBrowserCards(
      state,
      action: PayloadAction<{ browserIds: string[]; sessionId: string; label?: string }>
    ) {
      const { browserIds, sessionId, label } = action.payload;
      for (const id of browserIds) {
        state.glowingBrowserCards[id] = { sourceId: sessionId, fading: false, label };
      }
    },

    fadeGlowingBrowserCards(state, action: PayloadAction<string>) {
      const sessionId = action.payload;
      for (const entry of Object.values(state.glowingBrowserCards)) {
        if (entry.sourceId === sessionId) entry.fading = true;
      }
    },

    clearGlowingBrowserCards(state, action: PayloadAction<string>) {
      const sessionId = action.payload;
      for (const [browserId, entry] of Object.entries(state.glowingBrowserCards)) {
        if (entry.sourceId === sessionId) delete state.glowingBrowserCards[browserId];
      }
    },

    clearAllGlowingBrowserCards(state) {
      state.glowingBrowserCards = {};
    },

    setGlowingAgentCard(state, action: PayloadAction<{ sessionId: string; sourceId: string; sourceYRatio?: number; label?: string }>) {
      const { sessionId, sourceId, sourceYRatio, label } = action.payload;
      state.glowingAgentCards[sessionId] = { sourceId, fading: false, sourceYRatio, label };
    },

    fadeGlowingAgentCard(state, action: PayloadAction<string>) {
      const entry = state.glowingAgentCards[action.payload];
      if (entry) entry.fading = true;
    },

    clearGlowingAgentCard(state, action: PayloadAction<string>) {
      delete state.glowingAgentCards[action.payload];
    },

    resetLayout(state) {
      state.cards = {};
      state.viewCards = {};
      state.browserCards = {};
      state.workflowCards = {};
      state.workflowsHub = null;
      state.notes = {};
      state.closedCardPositions = {};
      state.glowingBrowserCards = {};
      state.glowingAgentCards = {};
      state.persistedExpandedSessionIds = [];
      state.nextZOrder = 1;
      state.initialized = false;
      state.pendingFocusNoteId = null;
      state.pendingFocusWorkflowId = null;
    },

  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchLayout.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchLayout.fulfilled, (state, action) => {
        state.loading = false;
        state.initialized = true;
        state.cards = action.payload.cards;
        state.viewCards = action.payload.viewCards;
        state.browserCards = action.payload.browserCards;
        state.workflowCards = action.payload.workflowCards || {};
        state.workflowsHub = action.payload.workflowsHub || null;
        state.notes = action.payload.notes || {};
        state.persistedExpandedSessionIds = action.payload.expandedSessionIds;

        let maxZ = 0;
        for (const c of Object.values(state.cards)) {
          if (!c.zOrder) c.zOrder = 0;
          if (c.zOrder > maxZ) maxZ = c.zOrder;
        }
        for (const c of Object.values(state.viewCards)) {
          if (!c.zOrder) c.zOrder = 0;
          if (c.zOrder > maxZ) maxZ = c.zOrder;
        }
        for (const c of Object.values(state.browserCards)) {
          if (!c.zOrder) c.zOrder = 0;
          if (c.zOrder > maxZ) maxZ = c.zOrder;
        }
        for (const w of Object.values(state.workflowCards)) {
          if (!w.zOrder) w.zOrder = 0;
          if (w.zOrder > maxZ) maxZ = w.zOrder;
        }
        for (const n of Object.values(state.notes)) {
          if (!n.zOrder) n.zOrder = 0;
          if (n.zOrder > maxZ) maxZ = n.zOrder;
        }
        state.nextZOrder = maxZ + 1;
      })
      .addCase(fetchLayout.rejected, (state) => {
        state.loading = false;
        state.initialized = true;
      })
      .addCase(fetchSessionRejectedAction, (state, action) => {
        // 404/410 means permanent; strip the card. Other failure modes leave it (next fetch may succeed).
        const payload = action.payload;
        if (!payload?.sessionId) return;
        if (payload.status !== 404 && payload.status !== 410) return;
        const id = payload.sessionId;
        if (state.cards[id]) delete state.cards[id];
        if (state.closedCardPositions[id]) delete state.closedCardPositions[id];
      })
      .addCase(deleteWorkflowFulfilledAction, (state, action) => {
        const id = action.payload;
        if (id && state.workflowCards[id]) delete state.workflowCards[id];
      })
      .addCase(launchAndSendFirstMessage.fulfilled, (state, action) => {
        const { draftId, session } = action.payload;
        const card = state.cards[draftId];
        if (card) {
          delete state.cards[draftId];
          state.cards[session.id] = { ...card, session_id: session.id, zOrder: state.nextZOrder++ };
        }
      });
  },
});

export const {
  setCardPosition,
  placeCard,
  setCardSize,
  removeCard,
  bringToFront,
  reconcileSessions,
  replaceDraftId,
  tidyLayout,
  addViewCard,
  setViewCardPosition,
  setViewCardSize,
  removeViewCard,
  addBrowserCard,
  addBrowserCardFromBackend,
  setBrowserCardPosition,
  setBrowserCardSize,
  removeBrowserCard,
  pasteBrowserCard,
  updateBrowserCardUrl,
  addBrowserTab,
  removeBrowserTab,
  setActiveBrowserTab,
  updateBrowserTabUrl,
  updateBrowserTabTitle,
  updateBrowserTabFavicon,
  reorderBrowserTab,
  moveCards,
  setGlowingBrowserCards,
  fadeGlowingBrowserCards,
  clearGlowingBrowserCards,
  clearAllGlowingBrowserCards,
  setGlowingAgentCard,
  fadeGlowingAgentCard,
  clearGlowingAgentCard,
  clearPendingFocusBrowserId,
  addWorkflowCard,
  setWorkflowCardPosition,
  setWorkflowCardSize,
  removeWorkflowCard,
  rekeyWorkflowCard,
  clearPendingFocusWorkflowId,
  openWorkflowsHub,
  closeWorkflowsHub,
  setWorkflowsHubPosition,
  setWorkflowsHubSize,
  clearPendingFocusWorkflowsHub,
  addNote,
  setNotePosition,
  setNoteSize,
  updateNoteContent,
  setNoteColor,
  removeNote,
  clearPendingFocusNoteId,
  resetLayout,
} = dashboardLayoutSlice.actions;

export default dashboardLayoutSlice.reducer;
