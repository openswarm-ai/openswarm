import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { launchAndSendFirstMessage } from './agentsSlice';
import { API_BASE } from '@/shared/config';

const DASHBOARDS_API = `${API_BASE}/dashboards`;

export const DEFAULT_CARD_W = 480;
export const DEFAULT_CARD_H = 280;
export const DEFAULT_VIEW_CARD_W = 480;
export const DEFAULT_VIEW_CARD_H = 360;
export const DEFAULT_BROWSER_CARD_W = 640;
export const DEFAULT_BROWSER_CARD_H = 480;
const GRID_GAP = 24;
const GRID_ORIGIN = { x: 40, y: 100 };
const GRID_COLS_FALLBACK = 4;

export interface CardPosition {
  session_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewCardPosition {
  output_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserCardPosition {
  browser_id: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DashboardLayoutState {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  loading: boolean;
  initialized: boolean;
}

const initialState: DashboardLayoutState = {
  cards: {},
  viewCards: {},
  browserCards: {},
  loading: false,
  initialized: false,
};

interface LayoutPayload {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
}

export const fetchLayout = createAsyncThunk(
  'dashboardLayout/fetch',
  async (dashboardId: string) => {
    const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`);
    const data = await res.json();
    const layout = data.layout ?? {};
    return {
      cards: (layout.cards ?? {}) as Record<string, CardPosition>,
      viewCards: (layout.view_cards ?? {}) as Record<string, ViewCardPosition>,
      browserCards: (layout.browser_cards ?? {}) as Record<string, BrowserCardPosition>,
    } satisfies LayoutPayload;
  },
);

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

interface SaveLayoutPayload extends LayoutPayload {
  dashboardId: string;
}

export const saveLayout = createAsyncThunk(
  'dashboardLayout/save',
  async (payload: SaveLayoutPayload) => {
    if (saveTimeout) clearTimeout(saveTimeout);
    return new Promise<SaveLayoutPayload>((resolve) => {
      saveTimeout = setTimeout(async () => {
        await fetch(`${DASHBOARDS_API}/${payload.dashboardId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            layout: { cards: payload.cards, view_cards: payload.viewCards, browser_cards: payload.browserCards },
          }),
        });
        resolve(payload);
      }, 500);
    });
  },
);

export function findOpenGridCell(
  existing: Record<string, { x: number; y: number }>,
  excludeIds: Set<string>,
  extraOccupied?: Record<string, { x: number; y: number }>,
): { x: number; y: number } {
  const cellW = DEFAULT_CARD_W + GRID_GAP;
  const cellH = DEFAULT_CARD_H + GRID_GAP;
  const maxCols = Math.max(
    1,
    Math.floor((window.innerWidth - GRID_ORIGIN.x) / cellW) || GRID_COLS_FALLBACK,
  );

  const occupied = new Set<string>();
  for (const [id, card] of Object.entries(existing)) {
    if (excludeIds.has(id)) continue;
    const col = Math.round((card.x - GRID_ORIGIN.x) / cellW);
    const row = Math.round((card.y - GRID_ORIGIN.y) / cellH);
    occupied.add(`${col},${row}`);
  }
  if (extraOccupied) {
    for (const card of Object.values(extraOccupied)) {
      const col = Math.round((card.x - GRID_ORIGIN.x) / cellW);
      const row = Math.round((card.y - GRID_ORIGIN.y) / cellH);
      occupied.add(`${col},${row}`);
    }
  }

  for (let row = 0; ; row++) {
    for (let col = 0; col < maxCols; col++) {
      if (!occupied.has(`${col},${row}`)) {
        return {
          x: GRID_ORIGIN.x + col * cellW,
          y: GRID_ORIGIN.y + row * cellH,
        };
      }
    }
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

    removeCard(state, action: PayloadAction<string>) {
      delete state.cards[action.payload];
    },

    reconcileSessions(state, action: PayloadAction<string[]>) {
      const liveIds = new Set(action.payload);

      for (const id of Object.keys(state.cards)) {
        if (!liveIds.has(id)) {
          delete state.cards[id];
        }
      }

      const hasDraftCard = Object.keys(state.cards).some((id) => id.startsWith('draft-'));
      const extraOccupied: Record<string, { x: number; y: number }> = {
        ...Object.fromEntries(Object.values(state.viewCards).map((c) => [c.output_id, c])),
        ...Object.fromEntries(Object.values(state.browserCards).map((c) => [c.browser_id, c])),
      };
      const newIds = action.payload.filter((id) => !state.cards[id]);
      for (const id of newIds) {
        if (hasDraftCard && !id.startsWith('draft-')) continue;
        const pos = findOpenGridCell(state.cards, new Set(), extraOccupied);
        state.cards[id] = {
          session_id: id,
          x: pos.x,
          y: pos.y,
          width: DEFAULT_CARD_W,
          height: DEFAULT_CARD_H,
        };
      }
    },

    tidyLayout(state) {
      const agentCards = Object.values(state.cards);
      const viewCards = Object.values(state.viewCards);
      const bCards = Object.values(state.browserCards);
      const total = agentCards.length + viewCards.length + bCards.length;
      if (total === 0) return;

      const allItems = [
        ...agentCards.map((c) => ({ kind: 'agent' as const, id: c.session_id, x: c.x, y: c.y })),
        ...viewCards.map((c) => ({ kind: 'view' as const, id: c.output_id, x: c.x, y: c.y })),
        ...bCards.map((c) => ({ kind: 'browser' as const, id: c.browser_id, x: c.x, y: c.y })),
      ];
      allItems.sort((a, b) => a.y - b.y || a.x - b.x);

      const cellW = DEFAULT_CARD_W + GRID_GAP;
      const cellH = DEFAULT_CARD_H + GRID_GAP;

      const slots: Array<[number, number]> = [];
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 3; col++) slots.push([col, row]);
      for (let row = 0; row < 3; row++) slots.push([3, row]);
      for (let col = 0; col < 4; col++) slots.push([col, 3]);
      for (let row = 4; slots.length < total; row++)
        for (let col = 0; col < 4 && slots.length < total; col++)
          slots.push([col, row]);

      allItems.forEach((item, i) => {
        const [col, row] = slots[i];
        const nx = GRID_ORIGIN.x + col * cellW;
        const ny = GRID_ORIGIN.y + row * cellH;
        if (item.kind === 'agent') {
          const card = state.cards[item.id];
          if (card) { card.x = nx; card.y = ny; card.width = DEFAULT_CARD_W; card.height = DEFAULT_CARD_H; }
        } else if (item.kind === 'view') {
          const card = state.viewCards[item.id];
          if (card) { card.x = nx; card.y = ny; card.width = DEFAULT_VIEW_CARD_W; card.height = DEFAULT_VIEW_CARD_H; }
        } else {
          const card = state.browserCards[item.id];
          if (card) { card.x = nx; card.y = ny; card.width = DEFAULT_BROWSER_CARD_W; card.height = DEFAULT_BROWSER_CARD_H; }
        }
      });
    },

    addViewCard(state, action: PayloadAction<{ outputId: string }>) {
      const { outputId } = action.payload;
      if (state.viewCards[outputId]) return;
      const pos = findOpenGridCell(state.cards, new Set(), state.viewCards);
      state.viewCards[outputId] = {
        output_id: outputId,
        x: pos.x,
        y: pos.y,
        width: DEFAULT_VIEW_CARD_W,
        height: DEFAULT_VIEW_CARD_H,
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

    addBrowserCard(state, action: PayloadAction<{ url: string }>) {
      const id = `browser-${Date.now().toString(36)}`;
      const allOccupied: Record<string, { x: number; y: number }> = {
        ...Object.fromEntries(Object.values(state.viewCards).map((c) => [c.output_id, c])),
        ...Object.fromEntries(Object.values(state.browserCards).map((c) => [c.browser_id, c])),
      };
      const pos = findOpenGridCell(state.cards, new Set(), allOccupied);
      state.browserCards[id] = {
        browser_id: id,
        url: action.payload.url,
        x: pos.x,
        y: pos.y,
        width: DEFAULT_BROWSER_CARD_W,
        height: DEFAULT_BROWSER_CARD_H,
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

    updateBrowserCardUrl(
      state,
      action: PayloadAction<{ browserId: string; url: string }>
    ) {
      const { browserId, url } = action.payload;
      const card = state.browserCards[browserId];
      if (card) { card.url = url; }
    },

    moveCards(
      state,
      action: PayloadAction<{
        items: Array<{ id: string; type: 'agent' | 'view' | 'browser' }>;
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
        } else {
          const card = state.browserCards[item.id];
          if (card) {
            card.x += dx;
            card.y += dy;
          }
        }
      }
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

    resetLayout(state) {
      state.cards = {};
      state.viewCards = {};
      state.browserCards = {};
      state.initialized = false;
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
      })
      .addCase(fetchLayout.rejected, (state) => {
        state.loading = false;
        state.initialized = true;
      })
      .addCase(launchAndSendFirstMessage.fulfilled, (state, action) => {
        const { draftId, session } = action.payload;
        const card = state.cards[draftId];
        if (card) {
          delete state.cards[draftId];
          state.cards[session.id] = { ...card, session_id: session.id };
        }
      });
  },
});

export const {
  setCardPosition,
  setCardSize,
  removeCard,
  reconcileSessions,
  replaceDraftId,
  tidyLayout,
  addViewCard,
  setViewCardPosition,
  setViewCardSize,
  removeViewCard,
  addBrowserCard,
  setBrowserCardPosition,
  setBrowserCardSize,
  removeBrowserCard,
  updateBrowserCardUrl,
  moveCards,
  resetLayout,
} = dashboardLayoutSlice.actions;

export default dashboardLayoutSlice.reducer;
