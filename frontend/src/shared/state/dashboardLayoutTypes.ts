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
}

export interface DashboardLayoutState {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  closedCardPositions: Record<string, CardPosition>;
  glowingBrowserCards: Record<string, { sourceId: string; fading: boolean; label?: string }>;
  glowingAgentCards: Record<string, { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string }>;
  persistedExpandedSessionIds: string[];
  nextZOrder: number;
  loading: boolean;
  initialized: boolean;
}

export const initialState: DashboardLayoutState = {
  cards: {},
  viewCards: {},
  browserCards: {},
  closedCardPositions: {},
  glowingBrowserCards: {},
  glowingAgentCards: {},
  persistedExpandedSessionIds: [],
  nextZOrder: 1,
  loading: false,
  initialized: false,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function collectOccupiedRects(
  state: DashboardLayoutState,
  expandedSessionIds?: string[],
): Rect[] {
  const expanded = new Set(expandedSessionIds);
  const rects: Rect[] = [];
  for (const c of Object.values(state.cards)) {
    const h = expanded.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height;
    rects.push({ x: c.x, y: c.y, w: c.width, h });
  }
  for (const c of Object.values(state.viewCards))
    rects.push({ x: c.x, y: c.y, w: c.width, h: c.height });
  for (const c of Object.values(state.browserCards))
    rects.push({ x: c.x, y: c.y, w: c.width, h: c.height });
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
      if (!occupiedRects.some((r) => rectsOverlap(candidate, r))) return { x, y };
    }
  }
}
