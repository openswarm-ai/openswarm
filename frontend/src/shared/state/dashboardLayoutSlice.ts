import { createSlice, createAsyncThunk, PayloadAction, createAction } from '@reduxjs/toolkit';
import { launchAndSendFirstMessage } from './agentsSlice';
import { API_BASE } from '@/shared/config';

// fetchSession 404/410 strips the layout card to stop AgentChat remount-loop. Matched by string to avoid circular import.
const fetchSessionRejectedAction = createAction<
  { sessionId?: string; status?: number } | undefined
>('agents/fetchSession/rejected');

const DASHBOARDS_API = `${API_BASE}/dashboards`;

export const DEFAULT_CARD_W = 480;
export const DEFAULT_CARD_H = 280;
export const DEFAULT_VIEW_CARD_W = 1280;
export const DEFAULT_VIEW_CARD_H = 800;
export const DEFAULT_BROWSER_CARD_W = 1280;
export const DEFAULT_BROWSER_CARD_H = 800;
export const EXPANDED_CARD_MIN_H = 620;
export const GRID_GAP = 24;
const GRID_ORIGIN = { x: 40, y: 100 };
const GRID_COLS_FALLBACK = 4;

export type CardType = 'agent' | 'view' | 'browser' | 'note';

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
  /** Dashboard this card belongs to; cards render and persist only on their owning dashboard. */
  dashboard_id?: string;
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
  /** Transient: snapshot stand-ins for off-screen webviews; never rides the layout PUT. */
  suspendedBrowserCards: Record<string, { dataUrl: string; capturedAt: number }>;
}

const initialState: DashboardLayoutState = {
  cards: {},
  viewCards: {},
  browserCards: {},
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
  suspendedBrowserCards: {},
};

interface LayoutPayload {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  notes: Record<string, NotePosition>;
  expandedSessionIds: string[];
}

function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const fetchLayout = createAsyncThunk(
  'dashboardLayout/fetch',
  // isReconnect distinguishes a socket-reconnect recovery refetch (merge, keep
  // live positions) from a fresh mount/switch load (replace, snapshot is the
  // user's saved layout). Passed explicitly, not inferred from state, so a
  // stale in-flight fetch from a previous dashboard can't be misread as a merge.
  async ({ dashboardId }: { dashboardId: string; isReconnect?: boolean }) => {
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

// Like findOpenGridCell but biased to stay near a proposed (x,y) anchor.
// Used when the backend hands us a card with a position that's already
// occupied (sub-agent or sub-browser spawning on top of its parent or a
// sibling). Spirals outward from the anchor on a grid, snapping to
// cell-aligned positions so the result still looks intentional, not
// dropped from orbit. Caps the spiral search at ~1000 cells to avoid
// pathological work in adversarial layouts , falls back to
// findOpenGridCell after that.
//
// Cost: O(rects × cells_scanned). Spawn events are rare (not per-frame),
// so this only runs when a new card appears. Typical scan resolves in
// <10 cells, well below the cap. No perf impact on steady-state UI.
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

  // Pathological , full canvas occupied near anchor. Fall back to the
  // global first-empty scan so we never return an overlap.
  return findOpenGridCell(occupiedRects, newW, newH);
}

// Reconnect-refetch merge: ADD only the cards the snapshot carries that the
// client is missing (e.g. a spawned browser whose broadcast was lost in a
// socket gap), collision-resolving each against the live layout so a recovered
// card can't land on a card already on canvas, and NEVER touch a card the
// client already has (that's exactly what preserves its live, collision-placed
// position). The shared `occupied` list carries placements forward so two
// recovered cards in the same pass also avoid each other.
function addMissingCards<T extends { x: number; y: number; width: number; height: number }>(
  live: Record<string, T>,
  incoming: Record<string, T>,
  occupied: Rect[],
): void {
  for (const id of Object.keys(incoming)) {
    if (live[id]) continue;
    const card = incoming[id];
    const pos = findOpenSpotNear(card.x, card.y, occupied, card.width, card.height);
    live[id] = { ...card, x: pos.x, y: pos.y };
    occupied.push({ x: pos.x, y: pos.y, w: card.width, h: card.height });
  }
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
        // Optional: which existing sessions are currently expanded
        // (showing their full chat history). Without this, the collision
        // check uses each card's STORED height , which is the collapsed
        // value , even when the card is currently rendering at the
        // expanded ~620px. Result: new sub-agent cards spawn into the
        // collapsed footprint but overlap the visually expanded one.
        // Caller (Dashboard.tsx) passes the current expanded set so
        // the collision math matches what the user actually sees.
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
      action: PayloadAction<{ id: string; type: 'agent' | 'view' | 'browser' | 'note' }>,
    ) {
      const { id, type } = action.payload;
      // Compute the current top zOrder across ALL card types so we can
      // short-circuit when the target is already on top. Without this
      // guard, every click on a card (which fires onPointerDownCapture +
      // onClick + onDoubleClick) bumps zOrder and triggers a Redux
      // mutation. That mutation cascades into a re-render that unmounts
      // inputs mid-keystroke.
      let maxZ = 0;
      let currentZ = 0;
      const tally = (z: number | undefined) => { if (typeof z === 'number' && z > maxZ) maxZ = z; };
      for (const c of Object.values(state.cards)) tally(c.zOrder);
      for (const c of Object.values(state.viewCards)) tally(c.zOrder);
      for (const c of Object.values(state.browserCards)) tally(c.zOrder);
      for (const n of Object.values(state.notes)) tally(n.zOrder);
      if (type === 'agent') currentZ = state.cards[id]?.zOrder ?? 0;
      else if (type === 'view') currentZ = state.viewCards[id]?.zOrder ?? 0;
      else if (type === 'note') currentZ = state.notes[id]?.zOrder ?? 0;
      else currentZ = state.browserCards[id]?.zOrder ?? 0;
      if (currentZ >= maxZ) return;  // Already on top: no-op.

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
      const total = agentCards.length + viewCards.length + bCards.length;
      if (total === 0) return;

      const allItems = [
        ...agentCards.map((c) => ({ kind: 'agent' as const, id: c.session_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...viewCards.map((c) => ({ kind: 'view' as const, id: c.output_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...bCards.map((c) => ({ kind: 'browser' as const, id: c.browser_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
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
      // Collision-resolve the backend-proposed position. Backend agents
      // often spawn sub-browsers at the parent's coordinates or at a
      // default (0,0) , without this guard, the new card lands on top
      // of an existing one and the user sees a single card with
      // multiple titles fighting for the z-index. Bias toward the
      // proposed position so the spawn still LOOKS related to wherever
      // the agent intended.
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
      delete state.suspendedBrowserCards[action.payload];
    },

    suspendBrowserCard(state, action: PayloadAction<{ browserId: string; dataUrl: string }>) {
      if (!state.browserCards[action.payload.browserId]) return;
      state.suspendedBrowserCards[action.payload.browserId] = {
        dataUrl: action.payload.dataUrl,
        capturedAt: Date.now(),
      };
    },

    resumeBrowserCard(state, action: PayloadAction<string>) {
      delete state.suspendedBrowserCards[action.payload];
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
        items: Array<{ id: string; type: 'agent' | 'view' | 'browser' | 'note' }>;
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
      state.notes = {};
      state.closedCardPositions = {};
      state.glowingBrowserCards = {};
      state.glowingAgentCards = {};
      state.persistedExpandedSessionIds = [];
      state.nextZOrder = 1;
      state.initialized = false;
      state.pendingFocusNoteId = null;
      state.suspendedBrowserCards = {};
    },

  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchLayout.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchLayout.fulfilled, (state, action) => {
        state.loading = false;
        // A fresh mount/switch load replaces (the snapshot is the user's saved
        // layout, authoritative). A reconnect refetch (useDashboardLifecycle
        // line ~90) recovers cards lost in a socket gap and must MERGE, blind-
        // replacing there clobbered the live, collision-placed positions of
        // cards already on canvas (the overlap / vanish under load while many
        // browsers spawn). The caller says which; never inferred from state.
        const isReconnectRefetch = action.meta.arg.isReconnect === true;
        state.initialized = true;
        const ownerDashboardId = action.meta.arg.dashboardId;
        if (!isReconnectRefetch) {
          state.cards = action.payload.cards;
          state.viewCards = action.payload.viewCards;
          state.browserCards = action.payload.browserCards;
          for (const card of Object.values(state.browserCards)) {
            card.dashboard_id = ownerDashboardId;
          }
          state.notes = action.payload.notes || {};
          // Cards boot parked (no guest process, title placeholder); the suspend
          // hook wakes viewport-sized and agent-driven ones on its first pass.
          // Beats mounting 100 webviews just to suspend 92 of them.
          state.suspendedBrowserCards = {};
          for (const id of Object.keys(action.payload.browserCards)) {
            state.suspendedBrowserCards[id] = { dataUrl: '', capturedAt: 0 };
          }
        } else {
          const occupied = collectOccupiedRects(state, action.payload.expandedSessionIds);
          addMissingCards(state.cards, action.payload.cards, occupied);
          addMissingCards(state.viewCards, action.payload.viewCards, occupied);
          addMissingCards(state.browserCards, action.payload.browserCards, occupied);
          for (const card of Object.values(state.browserCards)) {
            if (!card.dashboard_id) card.dashboard_id = ownerDashboardId;
          }
          addMissingCards(state.notes, action.payload.notes || {}, occupied);
        }
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
  suspendBrowserCard,
  resumeBrowserCard,
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
