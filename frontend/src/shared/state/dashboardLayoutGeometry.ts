import {
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  type CardType,
  type DashboardLayoutState,
} from './dashboardLayoutModel';

// The renderer's viewport, with the same fallbacks the callers always used; outside a window (the
// reducer tests run under node:test) it is just the fallback.
function viewportSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1440, h: 900 };
  return { w: window.innerWidth || 1440, h: window.innerHeight || 900 };
}

const GRID_ORIGIN = { x: 40, y: 100 };
const GRID_COLS_FALLBACK = 4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CardPlacementExclusion {
  type: CardType;
  id: string;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function collectOccupiedRects(
  state: DashboardLayoutState,
  expandedSessionIds?: string[],
  exclude?: CardPlacementExclusion,
): Rect[] {
  const expanded = new Set(expandedSessionIds);
  const rects: Rect[] = [];
  for (const c of Object.values(state.cards)) {
    if (exclude?.type === 'agent' && exclude.id === c.session_id) continue;
    const h = expanded.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height;
    rects.push({ x: c.x, y: c.y, w: c.width, h });
  }
  for (const c of Object.values(state.viewCards)) {
    if (exclude?.type === 'view' && exclude.id === c.output_id) continue;
    rects.push({ x: c.x, y: c.y, w: c.width, h: c.height });
  }
  for (const c of Object.values(state.browserCards)) {
    if (exclude?.type === 'browser' && exclude.id === c.browser_id) continue;
    rects.push({ x: c.x, y: c.y, w: c.width, h: c.height });
  }
  for (const w of Object.values(state.workflowCards)) {
    rects.push({ x: w.x, y: w.y, w: w.width, h: w.height });
  }
  if (state.workflowsHub) {
    rects.push({ x: state.workflowsHub.x, y: state.workflowsHub.y, w: state.workflowsHub.width, h: state.workflowsHub.height });
  }
  return rects;
}

export function findOpenGridCell(
  occupiedRects: Rect[],
  newW: number,
  newH: number,
  colLimit?: number,
): { x: number; y: number } {
  const cellW = DEFAULT_CARD_W + GRID_GAP;
  const cellH = DEFAULT_CARD_H + GRID_GAP;
  const maxCols = colLimit ?? Math.max(
    1,
    Math.floor((viewportSize().w - GRID_ORIGIN.x) / cellW) || GRID_COLS_FALLBACK,
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

// Like findOpenGridCell but biased to stay near a proposed (x,y) anchor. Used when the backend hands us a card with a position that's already occupied (sub-agent or sub-browser spawning on top of its parent or a sibling). Spirals outward from the anchor on a grid, snapping to cell-aligned positions so the result still looks intentional, not dropped from orbit. Caps the spiral search at ~1000 cells to avoid pathological work in adversarial layouts, falls back to findOpenGridCell after that. Cost: O(rects x cells_scanned). Spawn events are rare (not per-frame), so this only runs when a new card appears. Typical scan resolves in <10 cells, well below the cap. No perf impact on steady-state UI.
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

  // Pathological, full canvas occupied near anchor. Fall back to the global first-empty scan so we never return an overlap.
  return findOpenGridCell(occupiedRects, newW, newH);
}

// Dock a new card to the right of an anchor card, stacking under any cards already in that right-hand column. Anchor is any rect, so a browser can dock beside a normal agent card OR a workflow run/monitor card that has no session entry in state.cards.
export function placeBesideCard(
  state: DashboardLayoutState,
  anchor: { x: number; y: number; width: number; height: number },
  newW: number,
  newH: number,
  expandedSessionIds?: string[],
  exclude?: CardPlacementExclusion,
  gap: number = GRID_GAP * 12,
  exact: boolean = false,
): { x: number; y: number } {
  const rects = collectOccupiedRects(state, expandedSessionIds, exclude);
  const targetX = anchor.x + anchor.width + gap;
  const columnCards = [
    ...Object.values(state.browserCards).filter(
      (c) => !(exclude?.type === 'browser' && exclude.id === c.browser_id),
    ),
    ...Object.values(state.viewCards).filter(
      (c) => !(exclude?.type === 'view' && exclude.id === c.output_id),
    ),
  ].filter((c) => Math.abs(c.x - targetX) < 50);
  const targetY = columnCards.length > 0
    ? Math.max(...columnCards.map((c) => c.y + c.height)) + GRID_GAP
    : anchor.y;

  // exact keeps the precise gap (so the card mirrors however its anchor was placed, e.g. a run browser matching the hub->monitor gap); grid-snapping would knock that gap off. Fall back to the snapped search only if the exact spot is taken.
  if (exact && !rects.some((r) => rectsOverlap({ x: targetX, y: targetY, w: newW, h: newH }, r))) {
    return { x: targetX, y: targetY };
  }
  return findOpenSpotNear(targetX, targetY, rects, newW, newH);
}

// Dock a chat-spawned browser to the right of its chat card. Unlike placeBesideCard, this ALWAYS lands beside the chat (overlap is fine, the new card sits on top via zOrder) so an occupied spot can never fling the browser to a far grid cell or stack it under an unrelated card. Only this chat's OWN browsers (same spawned_by, still in the column) stack under each other so siblings don't fully cover one another; every other card is ignored.
export function placeBrowserBesideChat(
  state: DashboardLayoutState,
  chat: { x: number; y: number; width: number; height: number },
  parentSessionId: string,
  newW: number,
  newH: number,
  excludeBrowserId?: string,
): { x: number; y: number } {
  const targetX = chat.x + chat.width + GRID_GAP * 12;
  const siblings = Object.values(state.browserCards).filter(
    (c) => c.browser_id !== excludeBrowserId && c.spawned_by === parentSessionId && Math.abs(c.x - targetX) < 50,
  );
  const targetY = siblings.length > 0
    ? Math.max(...siblings.map((c) => c.y + c.height)) + GRID_GAP
    : chat.y;
  return { x: targetX, y: targetY };
}

// Dock a new card directly below an anchor card (left edges aligned). Used for a browser spawned by a Workflows-hub chat, which has no agent card to sit beside.
export function placeBelowCard(
  state: DashboardLayoutState,
  anchor: { x: number; y: number; width: number; height: number },
  newW: number,
  newH: number,
  expandedSessionIds?: string[],
  exclude?: CardPlacementExclusion,
): { x: number; y: number } {
  const rects = collectOccupiedRects(state, expandedSessionIds, exclude);
  return findOpenSpotNear(anchor.x, anchor.y + anchor.height + GRID_GAP, rects, newW, newH);
}

export function placeInParentColumn(
  state: DashboardLayoutState,
  parentSessionId: string | null | undefined,
  newW: number,
  newH: number,
  expandedSessionIds?: string[],
  exclude?: CardPlacementExclusion,
): { x: number; y: number } {
  const parentCard = parentSessionId ? state.cards[parentSessionId] : null;
  if (!parentCard) {
    return findOpenGridCell(collectOccupiedRects(state, expandedSessionIds, exclude), newW, newH);
  }
  return placeBesideCard(state, parentCard, newW, newH, expandedSessionIds, exclude);
}

// Where a user-created card (chat/app/browser) should land. Resolved in the UI layer where selection + viewport are known, then handed to the add reducers as an explicit x/y. `beside` (the currently selected card) docks the new card to its right, stacking under that column (collision-aware); `viewportCenter` (canvas-space center of what the user is looking at) drops it dead-center "in front of you", overlapping whatever's there. With neither, falls back to the legacy top-left grid scan.
export interface SpawnAnchor {
  beside?: { x: number; y: number; width: number; height: number };
  viewportCenter?: { x: number; y: number };
}

export function computeSpawnPosition(
  state: DashboardLayoutState,
  newW: number,
  newH: number,
  anchor: SpawnAnchor,
  expandedSessionIds?: string[],
): { x: number; y: number } {
  if (anchor.beside) {
    return placeBesideCard(state, anchor.beside, newW, newH, expandedSessionIds);
  }
  if (anchor.viewportCenter) {
    // Land dead-center, "in front of you", even if a card is already there. Overlap is intentional (new card sits on top via its higher zOrder); dodging to free space is exactly the "spawned off to the side" behavior we're removing.
    return { x: anchor.viewportCenter.x - newW / 2, y: anchor.viewportCenter.y - newH / 2 };
  }
  return findOpenGridCell(collectOccupiedRects(state, expandedSessionIds), newW, newH);
}

// Tidy packs into the grid shape that fills the SCREEN best. The default column count is derived from window.innerWidth, which is screen pixels pretending to be world units: it laid 8 cards out as a 2-wide, 4-tall ribbon that the camera then had to pull back to 41% to show.
export function tidyColumnCount(itemSizes: Array<{ w: number; h: number }>): number {
  const cellW = DEFAULT_CARD_W + GRID_GAP;
  const cellH = DEFAULT_CARD_H + GRID_GAP;
  let cells = 0;
  let widest = 1;
  for (const s of itemSizes) {
    const cols = Math.max(1, Math.ceil(s.w / cellW));
    cells += cols * Math.max(1, Math.ceil(s.h / cellH));
    widest = Math.max(widest, cols);
  }
  const { w: vw, h: vh } = viewportSize();
  let best = widest;
  let bestZoom = 0;
  for (let cols = widest; cols <= Math.max(widest, cells); cols++) {
    const rows = Math.ceil(cells / cols);
    const zoom = Math.min(vw / (cols * cellW), vh / (rows * cellH));
    if (zoom > bestZoom) {
      bestZoom = zoom;
      best = cols;
    }
  }
  return best;
}
