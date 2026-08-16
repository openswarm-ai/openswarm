import { restoredCardPosition } from './restoredCardPosition';
import { createSlice, createAsyncThunk, PayloadAction, createAction } from '@reduxjs/toolkit';
import { launchAndSendFirstMessage, resumeSession, collapseSession, collapseAllSessions, setExpandedSessionIds } from './agentsSlice';
import { untileClosedChats } from './untileClosedChats';
import { API_BASE } from '@/shared/config';
import { getLastDashboardId } from '@/shared/lastDashboardId';
import { isSafeMode } from '@/shared/safeMode';

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
export const DEFAULT_WORKFLOW_CARD_W = 480;
export const DEFAULT_WORKFLOW_CARD_H = 520;
// Open at the same default footprint as a browser/view card so it lands at a comfortable size automatically.
export const DEFAULT_WORKFLOWS_HUB_W = DEFAULT_BROWSER_CARD_W;
export const DEFAULT_WORKFLOWS_HUB_H = DEFAULT_BROWSER_CARD_H;
export const DEFAULT_SETTINGS_CARD_W = DEFAULT_BROWSER_CARD_W;
export const DEFAULT_SETTINGS_CARD_H = DEFAULT_BROWSER_CARD_H;
// The two singleton windows have no card map to key off, so they own these fixed ids everywhere (selection, minimize, z-order).
export const SETTINGS_CARD_ID = 'settings';
export const MARKETPLACE_CARD_ID = 'marketplace';
export const DEFAULT_MARKETPLACE_CARD_W = DEFAULT_BROWSER_CARD_W;
export const DEFAULT_MARKETPLACE_CARD_H = DEFAULT_BROWSER_CARD_H;
export const WORKFLOWS_HUB_ID = 'workflows-hub';
export const WORKFLOWS_MONITOR_ID = 'workflows-monitor';
export const EXPANDED_CARD_MIN_H = 620;
// The floating title bubble rides this far ABOVE an expanded chat's rect; camera fits that ignore it behead the title.
export const EXPANDED_HEADER_H = 64;
// The stored rect is a chat's COLLAPSED geometry; expanded it renders at least EXPANDED_CARD_MIN_H
// tall, so any camera fit, reveal, tidy, or collision math that frames the stored height of an
// expanded chat frames a lie and leaves the card's bottom off-screen (ENG-318).
export function renderedAgentCardHeight(storedHeight: number, expanded: boolean): number {
  return expanded ? Math.max(EXPANDED_CARD_MIN_H, storedHeight) : storedHeight;
}
export const GRID_GAP = 24;
// Gap between the Workflows window and the cards it spawns (run monitor, that monitor's browser). Keeps the hub -> monitor -> browser row evenly spaced.
export const WORKFLOW_CARD_GAP = 140;
const GRID_ORIGIN = { x: 40, y: 100 };
const GRID_COLS_FALLBACK = 4;

export type CardType = 'agent' | 'view' | 'browser' | 'workflow' | 'workflows-hub' | 'workflows-monitor' | 'settings' | 'marketplace';

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
  // Which instance of the app this card is (1 = primary, absent on pre-instance layouts). Each instance is a fully independent runtime on its own ports.
  instance?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  parent_session_id?: string | null;
  /** Chat session this app preview lives inside (renders over the chat's dock slot); null/absent = free card. */
  docked_to?: string | null;
  // Reveal-born apps start as a light "built for you, click to open" card so the onboarding curtain
  // lifts INSTANTLY instead of booting a live Vite preview in-frame. Cleared on first click -> boots.
  preview_deferred?: boolean;
}

// Record key + card identity for a view card. The primary keeps the bare output_id so persisted layouts and every existing by-output lookup stay valid; secondaries append #N.
export function viewCardKey(outputId: string, instance?: number): string {
  return (instance ?? 1) > 1 ? `${outputId}#${instance}` : outputId;
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
  keep_open?: boolean;
  /** Dashboard this card belongs to; cards render and persist only on their owning dashboard. */
  dashboard_id?: string;
  /** Chat session this browser lives inside (renders over the chat's dock slot); null/absent = free card. */
  docked_to?: string | null;
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

// One entry in the Ctrl/Cmd+Shift+T "reopen last closed" stack: a full snapshot for browser/view/workflow/tab, just the session id for an agent (its session is brought back via resumeSession).
export type ClosedCard =
  | { uid: string; kind: 'browser'; closedAt: number; card: BrowserCardPosition }
  | { uid: string; kind: 'view'; closedAt: number; card: ViewCardPosition }
  | { uid: string; kind: 'workflow'; closedAt: number; card: WorkflowCardPosition }
  | { uid: string; kind: 'tab'; closedAt: number; browserId: string; index: number; tab: BrowserTab }
  | { uid: string; kind: 'agent'; closedAt: number; sessionId: string; position: CardPosition | null };

export type ClosedCardKind = ClosedCard['kind'];

const RECENTLY_CLOSED_CAP = 25;
// Reopening a chat should drop it back where it was, so we remember closed cards' geometry. Nothing
// pruned it and it is persisted, so it grew forever and rode every layout save to disk: measured 555
// entries from 250 closes (the reconcile path records one too, so a close can bill twice). A position
// from hundreds of cards ago has no value, nobody reopens that, so keep the recent ones and drop the
// rest. Insertion order on a string-keyed object is the age order we need.
//
// The cap must clear the LARGEST board, not the typical one: a transient empty answer reconciles
// every card away at once and the restore reads these back, so a cap below the card count silently
// scatters the overflow into fresh grid cells. Measured at a cap of 50, a 60-card board lost exactly
// 10 cards, which is why this number is not 50.
const CLOSED_POSITIONS_CAP = 1000;

function rememberClosedPosition(
  map: Record<string, CardPosition>, id: string, pos: CardPosition,
): void {
  // Re-closing the same card must refresh its age, not keep the stale slot.
  delete map[id];
  map[id] = pos;
  const ids = Object.keys(map);
  for (let i = 0; i < ids.length - CLOSED_POSITIONS_CAP; i++) delete map[ids[i]];
}

export interface DashboardLayoutState {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  closedCardPositions: Record<string, CardPosition>;
  /** Session-global LIFO undo stack for Ctrl/Cmd+Shift+T; survives dashboard switches (resetLayout leaves it alone). */
  recentlyClosed: ClosedCard[];
  glowingBrowserCards: Record<string, { sourceId: string; fading: boolean; label?: string }>;
  glowingAgentCards: Record<string, { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string }>;
  /** Window controls: cards collapsed to a title pill (many at once). Keyed by any card id (session/browser/view/workflow). */
  minimizedCards: Record<string, boolean>;
  /** macOS-style tiling: card id -> zone ('fullscreen' | 'fill' | 'left'|'right'|'top'|'bottom' | 'tl'|'tr'|'bl'|'br' | 't3l'|'t3c'|'t3r'). A tiled card renders at that viewport region (webview stays mounted); 'fullscreen' also hides the app chrome. */
  tiledCards: Record<string, string>;
  persistedExpandedSessionIds: string[];
  nextZOrder: number;
  loading: boolean;
  initialized: boolean;
  /** True only after a SUCCESSFUL layout fetch for the current dashboard; saveLayout is a no-op until then (a failed boot fetch must never wipe the server layout). */
  saveArmed: boolean;
  /** Transient: new browser card id; Dashboard pans/zooms to it then clears via clearPendingFocusBrowserId. */
  pendingFocusBrowserId: string | null;
  // Set when a view card is opened from outside the canvas (sidebar app click / toolbar picker) so the dashboard fits+highlights it on arrival; holds the card key.
  pendingFocusViewCardId: string | null;
  /** Transient: snapshot stand-ins for off-screen webviews; never rides the layout PUT. */
  suspendedBrowserCards: Record<string, { dataUrl: string; capturedAt: number }>;
  /** Transient: spawned cards that are about to be removed; surfaces the fade + Keep pill. */
  endingBrowserCards: Record<string, { status: 'completed' | 'error'; at: number }>;
  /** Transient: id of the view card the user has clicked into; preload stops forwarding canvas gestures while set. */
  activeViewCardId: string | null;
  pendingFocusWorkflowId: string | null;
  /** Transient: signals Dashboard to pan/zoom to the singleton Workflows Hub on open. */
  pendingFocusWorkflowsHub: boolean;
  /** Transient deep-link target: the Workflows card jumps to this workflow's detail on open, then clears it. */
  workflowsAppTarget: string | null;
  /** Workflow id whose live run is being watched in the Run Monitor card docked beside the window. Null = closed. */
  workflowsMonitorId: string | null;
  /** Specific run id to show in the monitor (e.g. clicked from history); null = follow the latest run. */
  workflowsMonitorRunId: string | null;
  /** Geometry of the spawned Run Monitor card (a real canvas card, tethered to the window). Ephemeral, not persisted. */
  workflowsMonitorCard: WorkflowsHubPosition | null;
  /** A run attached to a workflow's chat as a removable context chip; its transcript rides along each send until removed. */
  workflowsRunContext: WorkflowsRunContext | null;
  /** Settings as an on-canvas window (singleton). Ephemeral, not persisted: a fresh boot opens on a clean canvas. */
  settingsCard: WorkflowsHubPosition | null;
  /** Transient: signals Dashboard to pan/zoom to the Settings window on open. */
  pendingFocusSettingsCard: boolean;
  /** Transient deep-link: which settings tab to land on; SettingsBody consumes and clears it. */
  settingsRequestedTab: string | null;
  /** Marketplace as an on-canvas window (singleton), same lifecycle as the Settings window. */
  marketplaceCard: WorkflowsHubPosition | null;
  /** Transient: signals Dashboard to pan/zoom to the Marketplace window on open. */
  pendingFocusMarketplaceCard: boolean;
  /** Transient deep-link: which marketplace view to land on; the card consumes and clears it. */
  marketplaceRequestedTab: string | null;
  /** Focus-order overrides, keyed by card id (singletons use their literal ids). bringToFront writes ONLY here, so a click never churns card-object identities; effective z = zOrders[id] ?? the base stamped at creation. */
  zOrders: Record<string, number>;
  /** Creation-order ledger, oldest first, across all content card types; the trash's no-selection press pops the newest. Persisted with the layout (zOrder can't stand in, it re-bumps on every focus). */
  creationOrder: string[];
}

export interface WorkflowsRunContext {
  workflowId: string;
  runId: string;
  title: string;
  metaLabel: string;
  color: string;
}

const initialState: DashboardLayoutState = {
  cards: {},
  viewCards: {},
  browserCards: {},
  workflowCards: {},
  workflowsHub: null,
  closedCardPositions: {},
  recentlyClosed: [],
  glowingBrowserCards: {},
  glowingAgentCards: {},
  minimizedCards: {},
  tiledCards: {},
  persistedExpandedSessionIds: [],
  nextZOrder: 1,
  loading: false,
  initialized: false,
  saveArmed: false,
  pendingFocusBrowserId: null,
  pendingFocusViewCardId: null,
  suspendedBrowserCards: {},
  endingBrowserCards: {},
  activeViewCardId: null,
  pendingFocusWorkflowId: null,
  pendingFocusWorkflowsHub: false,
  workflowsAppTarget: null,
  workflowsMonitorId: null,
  workflowsMonitorRunId: null,
  workflowsMonitorCard: null,
  workflowsRunContext: null,
  settingsCard: null,
  pendingFocusSettingsCard: false,
  settingsRequestedTab: null,
  marketplaceCard: null,
  pendingFocusMarketplaceCard: false,
  marketplaceRequestedTab: null,
  creationOrder: [],
  zOrders: {},
};

interface LayoutPayload {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  expandedSessionIds: string[];
  creationOrder: string[];
  // Optional because savers omit it: the save thunk reads the live map from state itself.
  zOrders?: Record<string, number>;
}

// Window-state entries (tiles, minimized pills) are only meaningful while some card map owns the id.
function tileOwnerExists(s: DashboardLayoutState, id: string): boolean {
  return id in s.cards || id in s.viewCards || id in s.browserCards || id in s.workflowCards
    || (id === WORKFLOWS_HUB_ID && !!s.workflowsHub) || (id === SETTINGS_CARD_ID && !!s.settingsCard)
    || (id === MARKETPLACE_CARD_ID && !!s.marketplaceCard)
    // The Run Monitor is a real tileable surface everywhere else in this file; leaving it out here
    // would silently report its fullscreen as "owner gone" and leave the canvas chrome on top of it.
    || (id === WORKFLOWS_MONITOR_ID && !!s.workflowsMonitorCard);
}

function ledgerAdd(ledger: string[], id: string): void {
  if (!ledger.includes(id)) ledger.push(id);
}

function ledgerRemove(ledger: string[], id: string): void {
  const i = ledger.indexOf(id);
  if (i !== -1) ledger.splice(i, 1);
}

function ledgerRekey(ledger: string[], oldId: string, newId: string): void {
  const i = ledger.indexOf(oldId);
  if (i !== -1) ledger[i] = newId;
  else ledgerAdd(ledger, newId);
}

function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const fetchLayout = createAsyncThunk(
  'dashboardLayout/fetch',
  // isReconnect distinguishes a socket-reconnect recovery refetch (merge, keep live positions) from a fresh mount/switch load (replace, snapshot is the user's saved layout). Passed explicitly, not inferred from state, so a stale in-flight fetch from a previous dashboard can't be misread as a merge.
  async ({ dashboardId }: { dashboardId: string; isReconnect?: boolean }) => {
    const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`);
    // A non-2xx body silently parsing to "no layout" is how a healthy dashboard gets wiped: the empty result gets marked initialized and the next debounced save persists it.
    if (!res.ok) throw new Error(`layout fetch failed: ${res.status}`);
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
      expandedSessionIds: (layout.expanded_session_ids ?? []) as string[],
      creationOrder: (layout.creation_order ?? []) as string[],
      zOrders: (layout.z_orders ?? {}) as Record<string, number>,
    } satisfies LayoutPayload;
  },
);

interface SaveLayoutPayload extends LayoutPayload {
  dashboardId: string;
}

export const saveLayout = createAsyncThunk(
  'dashboardLayout/save',
  async (payload: SaveLayoutPayload, { getState }) => {
    // Never persist a layout this client never successfully loaded; a failed boot fetch otherwise saves the pristine empty store over the server's real layout (the wipe class).
    const dl = (getState() as { dashboardLayout: { saveArmed: boolean; zOrders: Record<string, number> } }).dashboardLayout;
    if (!dl.saveArmed) return payload;
    // Prune focus overrides to ids that still exist, so removed cards can't grow the map forever.
    const liveZ: Record<string, number> = {};
    for (const [zid, z] of Object.entries(dl.zOrders)) {
      if (payload.cards[zid] || payload.viewCards[zid] || payload.browserCards[zid] || payload.workflowCards[zid]
        || zid === 'settings' || zid === 'marketplace' || zid === 'workflows-hub' || zid === 'workflows-monitor') liveZ[zid] = z;
    }
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
          expanded_session_ids: payload.expandedSessionIds,
          creation_order: payload.creationOrder,
          z_orders: liveZ,
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

interface CardPlacementExclusion {
  type: CardType;
  id: string;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function collectOccupiedRects(
  state: DashboardLayoutState,
  expandedSessionIds?: string[],
  exclude?: CardPlacementExclusion,
): Rect[] {
  const expanded = new Set(expandedSessionIds);
  const rects: Rect[] = [];
  for (const c of Object.values(state.cards)) {
    if (exclude?.type === 'agent' && exclude.id === c.session_id) continue;
    const h = renderedAgentCardHeight(c.height, expanded.has(c.session_id));
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
  if (state.settingsCard) {
    rects.push({ x: state.settingsCard.x, y: state.settingsCard.y, w: state.settingsCard.width, h: state.settingsCard.height });
  }
  if (state.marketplaceCard) {
    rects.push({ x: state.marketplaceCard.x, y: state.marketplaceCard.y, w: state.marketplaceCard.width, h: state.marketplaceCard.height });
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

// Tidy packs into the grid shape that fills the SCREEN best. The default column count is derived from
// window.innerWidth, which is screen pixels pretending to be world units: it laid 8 cards out as a
// 2-wide, 4-tall ribbon that the camera then had to pull back to 41% to show.
function tidyColumnCount(itemSizes: Array<{ w: number; h: number }>): number {
  const cellW = DEFAULT_CARD_W + GRID_GAP;
  const cellH = DEFAULT_CARD_H + GRID_GAP;
  let cells = 0;
  let widest = 1;
  for (const s of itemSizes) {
    const cols = Math.max(1, Math.ceil(s.w / cellW));
    cells += cols * Math.max(1, Math.ceil(s.h / cellH));
    widest = Math.max(widest, cols);
  }
  const vw = window.innerWidth || 1440;
  const vh = window.innerHeight || 900;
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

// Like findOpenGridCell but biased to stay near a proposed (x,y) anchor. Used when the backend hands us a card with a position that's already occupied (sub-agent or sub-browser spawning on top of its parent or a sibling). Spirals outward from the anchor on a grid, snapping to cell-aligned positions so the result still looks intentional, not dropped from orbit. Caps the spiral search at ~1000 cells to avoid pathological work in adversarial layouts, falls back to findOpenGridCell after that. Cost: O(rects × cells_scanned). Spawn events are rare (not per-frame), so this only runs when a new card appears. Typical scan resolves in <10 cells, well below the cap. No perf impact on steady-state UI.
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

  // Ring order approximates distance but returns the first-in-scan cell, which flings a card to a
  // far corner when the near cells are blocked (a big browser + expanded chats). Instead pick the
  // cell CLOSEST to the anchor by real distance: scan outward, and once a ring yields a free cell,
  // scan ONE more ring (a ring-r corner ~r*1.41 can lose to a ring-(r+1) edge) then take the nearest.
  const MAX_RING = 32;
  const spotDist = (col: number, row: number): number => {
    const x = GRID_ORIGIN.x + col * cellW;
    const y = GRID_ORIGIN.y + row * cellH;
    return Math.hypot(x - anchorX, y - anchorY);
  };
  let best: { col: number; row: number; d: number } | null = null;
  let firstHitRing = -1;
  for (let r = 1; r <= MAX_RING; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const col = baseCol + dx;
        const row = baseRow + dy;
        if (col < 0 || row < 0) continue;
        if (!cellFree(col, row)) continue;
        const d = spotDist(col, row);
        if (!best || d < best.d) best = { col, row, d };
      }
    }
    if (best && firstHitRing === -1) firstHitRing = r;
    // Scan one ring past the first hit (a ring-r corner can lose to a ring-(r+1) edge), then commit.
    if (firstHitRing !== -1 && r >= firstHitRing + 1) break;
  }
  if (best) {
    return {
      x: GRID_ORIGIN.x + best.col * cellW,
      y: GRID_ORIGIN.y + best.row * cellH,
    };
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

// Which card map holds this id, plus the exclusion tag `collectOccupiedRects` needs so a card is
// never treated as blocking its own restore.
function p_placedCard(state: DashboardLayoutState, id: string):
  { card: { x: number; y: number; width: number; height: number }; exclude: CardPlacementExclusion } | null {
  const agent = Object.values(state.cards).find((c) => c.session_id === id);
  if (agent) return { card: agent, exclude: { type: 'agent', id } };
  const view = Object.values(state.viewCards).find((c) => c.output_id === id);
  if (view) return { card: view, exclude: { type: 'view', id } };
  const browser = Object.values(state.browserCards).find((c) => c.browser_id === id);
  if (browser) return { card: browser, exclude: { type: 'browser', id } };
  return null;
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
    // Closest open gap to the viewport center: dead-center-with-overlap stacked spawns invisibly on top of each other (two center spawns in a row = the second fully covers the first). The spiral stays center-biased so it still reads as "in front of you".
    return findOpenSpotNear(
      anchor.viewportCenter.x - newW / 2,
      anchor.viewportCenter.y - newH / 2,
      collectOccupiedRects(state, expandedSessionIds),
      newW,
      newH,
    );
  }
  return findOpenGridCell(collectOccupiedRects(state, expandedSessionIds), newW, newH);
}

// Reconnect-refetch merge: ADD only the cards the snapshot carries that the client is missing (e.g. a spawned browser whose broadcast was lost in a socket gap), collision-resolving each against the live layout so a recovered card can't land on a card already on canvas, and NEVER touch a card the client already has (that's exactly what preserves its live, collision-placed position). The shared `occupied` list carries placements forward so two recovered cards in the same pass also avoid each other.
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

// One docked surface per chat: the slot is a single rect, so docking a new browser/app releases
// whatever was previously docked there (it falls back to its stored free position).
function clearOtherDocks(state: { browserCards: Record<string, BrowserCardPosition>; viewCards: Record<string, ViewCardPosition> }, sessionId: string, keepBrowserId?: string): void {
  for (const bc of Object.values(state.browserCards)) {
    if (bc.docked_to !== sessionId) continue;
    // The card being (re-)docked must survive its own clear: layout sync re-asserts docks.
    if (bc.browser_id === keepBrowserId) continue;
    // Corpse cleanup happens in WebSocketManager via removeBrowserCardCleanly, NOT here: a bare store delete gets resurrected by the backend layout sync as a free card.
    bc.docked_to = null;
  }
  for (const vc of Object.values(state.viewCards)) {
    if (vc.docked_to === sessionId) vc.docked_to = null;
  }
}

const dashboardLayoutSlice = createSlice({
  name: 'dashboardLayout',
  initialState,
  reducers: {
    // Window controls (traffic lights). Minimize parks a card in the right-edge rail; tiling snaps it
    // to a macOS-style viewport zone. Rule 6 of the tiling set (see cards/useCardTiling.ts): a parked
    // card keeps its zone and restores back into it, but never keeps 'fullscreen', which would leave
    // an off-canvas card hiding the whole shell.
    toggleMinimizeCard(state, action: PayloadAction<{ cardId: string }>) {
      const id = action.payload.cardId;
      if (state.minimizedCards[id]) {
        delete state.minimizedCards[id];
        // Coming back onto an occupied slot lands the card on top of whatever took its place while
        // it was parked. Keep the user's spot when it is still free, reflow only when it is not.
        const owner = p_placedCard(state, id);
        if (owner) {
          const occupied = collectOccupiedRects(state, undefined, owner.exclude);
          const next = restoredCardPosition(
            { x: owner.card.x, y: owner.card.y, w: owner.card.width, h: owner.card.height },
            occupied,
            findOpenSpotNear,
          );
          owner.card.x = next.x;
          owner.card.y = next.y;
        }
      } else {
        state.minimizedCards[id] = true;
        if (state.tiledCards[id] === 'fullscreen') delete state.tiledCards[id];
      }
    },
    setTiledCard(state, action: PayloadAction<{ cardId: string; zone: string }>) {
      const { cardId, zone } = action.payload;
      // The rail defers its tile dispatch two frames, so the card can be gone by the time it lands; a stranded 'fullscreen' hides the whole shell.
      if (!tileOwnerExists(state, cardId)) return;
      // One fullscreen owner, ever: two entries would fight over who hides the chrome and who gets the Escape.
      if (zone === 'fullscreen') {
        for (const [id, z] of Object.entries(state.tiledCards)) {
          if (z === 'fullscreen' && id !== cardId) delete state.tiledCards[id];
        }
      }
      state.tiledCards[cardId] = zone;
      if (state.minimizedCards[cardId]) delete state.minimizedCards[cardId];
    },
    clearTiledCard(state, action: PayloadAction<string>) {
      if (state.tiledCards[action.payload]) delete state.tiledCards[action.payload];
    },
    clearAllTiles(state) {
      state.tiledCards = {};
    },
    clearCardWindowState(state, action: PayloadAction<string>) {
      const id = action.payload;
      if (state.minimizedCards[id]) delete state.minimizedCards[id];
      if (state.tiledCards[id]) delete state.tiledCards[id];
    },
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
        // Optional: which existing sessions are currently expanded (showing their full chat history). Without this, the collision check uses each card's STORED height, which is the collapsed value, even when the card is currently rendering at the expanded ~620px. Result: new sub-agent cards spawn into the collapsed footprint but overlap the visually expanded one. Caller (Dashboard.tsx) passes the current expanded set so the collision math matches what the user actually sees.
        expandedSessionIds?: string[];
        // Honor the given x/y verbatim (dead-center "in front of you", overlap allowed) instead of collision-dodging to a free grid cell. Set when the caller already resolved the spot (viewport center / beside a selected card) and dodging would defeat that; tidyLayout cleans up any overlap on demand.
        exact?: boolean;
      }>
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

    bringToFront(
      state,
      action: PayloadAction<{ id: string; type: CardType }>,
    ) {
      const { id, type } = action.payload;
      // Focus writes ONLY the override map: the old form mutated the card object, which replaced its
      // dict, re-rendered the controller + tethers + dock + minimap, and armed a layout PUT +
      // thumbnail capture on every press (CANVAS_LAG_NOTES item 33). The nextZOrder-1 holder is
      // always the top card, so the already-on-top guard (workflow textarea focus-loss) is one compare.
      let base = 0;
      if (type === 'agent') base = state.cards[id]?.zOrder ?? 0;
      else if (type === 'view') base = state.viewCards[id]?.zOrder ?? 0;
      else if (type === 'workflow') base = state.workflowCards[id]?.zOrder ?? 0;
      else if (type === 'workflows-hub') base = state.workflowsHub?.zOrder ?? 0;
      else if (type === 'workflows-monitor') base = state.workflowsMonitorCard?.zOrder ?? 0;
      else if (type === 'settings') base = state.settingsCard?.zOrder ?? 0;
      else if (type === 'marketplace') base = state.marketplaceCard?.zOrder ?? 0;
      else base = state.browserCards[id]?.zOrder ?? 0;
      const effective = state.zOrders[id] ?? base;
      // Zero is the legacy every-card tie (backend-synced cards arrive without z); never short-circuit on it.
      if (effective > 0 && effective === state.nextZOrder - 1) return;
      state.zOrders[id] = state.nextZOrder++;
    },

    removeCard(state, action: PayloadAction<string>) {
      delete state.cards[action.payload];
      delete state.tiledCards[action.payload];
      delete state.minimizedCards[action.payload];
      // zOrders had three writers and no deleter, so every card ever focused stayed in it forever,
      // and it is PERSISTED: the entry rode every layout save to disk and back on every fetch. Small
      // per row, unbounded over a long-lived board.
      delete state.zOrders[action.payload];
      ledgerRemove(state.creationOrder, action.payload);
    },

    reconcileSessions(
      state,
      action: PayloadAction<{ sessionIds: string[]; expandedSessionIds: string[]; keepIds?: string[] }>,
    ) {
      const { sessionIds, expandedSessionIds, keepIds } = action.payload;
      const liveIds = new Set(sessionIds);
      // Revealed sub-agent cards live OUTSIDE the deserving list, so without this exemption any
      // unrelated spawn despawned another agent's live subagents (ENG-304). Keep is not create:
      // these ids never earn a card here, they only stop losing one.
      for (const id of keepIds ?? []) liveIds.add(id);

      for (const id of Object.keys(state.cards)) {
        if (!liveIds.has(id)) {
          rememberClosedPosition(state.closedCardPositions, id, { ...state.cards[id] });
          delete state.cards[id];
          // A dead card must never keep owning a tile: an orphaned 'fullscreen' entry hides ALL chrome until reload.
          delete state.tiledCards[id];
          delete state.minimizedCards[id];
          delete state.zOrders[id];
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
        ledgerAdd(state.creationOrder, id);
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
      const hub = state.workflowsHub;
      const mon = state.workflowsMonitorCard;
      const settings = state.settingsCard;
      const market = state.marketplaceCard;
      const total = agentCards.length + viewCards.length + bCards.length + wCards.length + (hub ? 1 : 0) + (mon ? 1 : 0) + (settings ? 1 : 0) + (market ? 1 : 0);
      if (total === 0) return;

      const allItems = [
        ...agentCards.map((c) => ({ kind: 'agent' as const, id: c.session_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...viewCards.map((c) => ({ kind: 'view' as const, id: viewCardKey(c.output_id, c.instance), x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...bCards.map((c) => ({ kind: 'browser' as const, id: c.browser_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...wCards.map((c) => ({ kind: 'workflow' as const, id: c.workflow_id, x: c.x, y: c.y, storedW: c.width, storedH: c.height })),
        ...(hub ? [{ kind: 'workflows-hub' as const, id: 'workflows-hub', x: hub.x, y: hub.y, storedW: hub.width, storedH: hub.height }] : []),
        ...(mon ? [{ kind: 'workflows-monitor' as const, id: 'workflows-monitor', x: mon.x, y: mon.y, storedW: mon.width, storedH: mon.height }] : []),
        ...(settings ? [{ kind: 'settings' as const, id: SETTINGS_CARD_ID, x: settings.x, y: settings.y, storedW: settings.width, storedH: settings.height }] : []),
        ...(market ? [{ kind: 'marketplace' as const, id: MARKETPLACE_CARD_ID, x: market.x, y: market.y, storedW: market.width, storedH: market.height }] : []),
      ];
      allItems.sort((a, b) => a.y - b.y || a.x - b.x);

      const sizeOf = (item: typeof allItems[number]): { w: number; h: number } => ({
        w: item.storedW,
        h: renderedAgentCardHeight(item.storedH, item.kind === 'agent' && expanded.has(item.id)),
      });
      const cols = tidyColumnCount(allItems.map(sizeOf));
      const placedRects: Rect[] = [];

      for (const item of allItems) {
        const { w, h } = sizeOf(item);

        const pos = findOpenGridCell(placedRects, w, h, cols);
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
        } else if (item.kind === 'workflows-hub') {
          if (state.workflowsHub) { state.workflowsHub.x = pos.x; state.workflowsHub.y = pos.y; }
        } else if (item.kind === 'workflows-monitor') {
          if (state.workflowsMonitorCard) { state.workflowsMonitorCard.x = pos.x; state.workflowsMonitorCard.y = pos.y; }
        } else if (item.kind === 'settings') {
          if (state.settingsCard) { state.settingsCard.x = pos.x; state.settingsCard.y = pos.y; }
        } else if (item.kind === 'marketplace') {
          if (state.marketplaceCard) { state.marketplaceCard.x = pos.x; state.marketplaceCard.y = pos.y; }
        } else {
          const card = state.browserCards[item.id];
          if (card) { card.x = pos.x; card.y = pos.y; }
        }
      }
    },

    addViewCard(state, action: PayloadAction<{
      outputId: string; expandedSessionIds?: string[];
      parentSessionId?: string | null;
      x?: number; y?: number; width?: number; height?: number;
      // Open ANOTHER independent instance of an already-open app instead of no-op'ing.
      newInstance?: boolean;
      // Reveal-only: start as a light "click to open" card instead of booting the preview eagerly.
      previewDeferred?: boolean;
    }>) {
      const { outputId, expandedSessionIds, parentSessionId, x, y, width, height, newInstance, previewDeferred } = action.payload;
      let instance = 1;
      if (state.viewCards[outputId]) {
        if (!newInstance) return;
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
      ledgerAdd(state.creationOrder, cardKey);
      state.pendingFocusViewCardId = cardKey;
    },

    // First click on a reveal-parked app card: drop the defer so its live preview boots.
    activateViewCardPreview(state, action: PayloadAction<string>) {
      const card = state.viewCards[action.payload];
      if (card && card.preview_deferred) card.preview_deferred = undefined;
    },

    clearPendingFocusViewCardId(state) {
      state.pendingFocusViewCardId = null;
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
      delete state.tiledCards[action.payload];
      delete state.minimizedCards[action.payload];
      delete state.zOrders[action.payload];
      ledgerRemove(state.creationOrder, action.payload);
      if (state.activeViewCardId === action.payload) state.activeViewCardId = null;
    },

    setActiveViewCardId(state, action: PayloadAction<string | null>) {
      state.activeViewCardId = action.payload;
    },

    addBrowserCard(state, action: PayloadAction<{ url: string; expandedSessionIds?: string[]; x?: number; y?: number }>) {
      // Two browsers created in the same millisecond used to get the SAME id and the second
      // silently overwrote the first: measured, adding 8 in a loop produced 6. generateTabId three
      // lines up already learned this; the card id never did.
      const id = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const tabId = generateTabId();
      // Caller may pre-resolve the spawn position (beside the selected card, or in front of the viewport); otherwise fall back to the top-left grid scan.
      const pos = action.payload.x != null && action.payload.y != null
        ? { x: action.payload.x, y: action.payload.y }
        : findOpenGridCell(collectOccupiedRects(state, action.payload.expandedSessionIds), DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
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
        // Born onto the current dashboard so it shows there and only there, never bleeding onto every dashboard while it waits for the first layout save to tag it.
        dashboard_id: getLastDashboardId() ?? undefined,
      };
      ledgerAdd(state.creationOrder, id);
      state.pendingFocusBrowserId = id;
    },

    clearPendingFocusBrowserId(state) {
      state.pendingFocusBrowserId = null;
    },

    // Camera-focus an EXISTING card (the inline chat embeds' "show on canvas"); the lifecycle
    // pendingFocus effects own the fit + highlight + clear, same as a fresh add.
    focusBrowserCard(state, action: PayloadAction<string>) {
      if (state.browserCards[action.payload]) state.pendingFocusBrowserId = action.payload;
    },
    focusViewCard(state, action: PayloadAction<string>) {
      if (state.viewCards[action.payload]) state.pendingFocusViewCardId = action.payload;
    },

    setViewDocked(state, action: PayloadAction<{ cardKey: string; dockedTo: string | null }>) {
      const vc = state.viewCards[action.payload.cardKey];
      if (!vc) return;
      if (action.payload.dockedTo) clearOtherDocks(state, action.payload.dockedTo);
      vc.docked_to = action.payload.dockedTo;
    },
    setBrowserDocked(state, action: PayloadAction<{ browserId: string; dockedTo: string | null }>) {
      const bc = state.browserCards[action.payload.browserId];
      if (!bc) return;
      if (action.payload.dockedTo) clearOtherDocks(state, action.payload.dockedTo, action.payload.browserId);
      bc.docked_to = action.payload.dockedTo;
    },
    addBrowserCardFromBackend(state, action: PayloadAction<BrowserCardPosition>) {
      const card = action.payload;
      if (state.browserCards[card.browser_id]) return;
      const w = card.width || DEFAULT_BROWSER_CARD_W;
      const h = card.height || DEFAULT_BROWSER_CARD_H;
      // Collision-resolve the backend-proposed position. Backend agents often spawn sub-browsers at the parent's coordinates or at a default (0,0), without this guard, the new card lands on top of an existing one and the user sees a single card with multiple titles fighting for the z-index. Bias toward the proposed position so the spawn still LOOKS related to wherever the agent intended.
      const rects = collectOccupiedRects(state);
      const pos = findOpenSpotNear(card.x, card.y, rects, w, h);
      state.browserCards[card.browser_id] = {
        ...card,
        x: pos.x,
        y: pos.y,
        width: w,
        height: h,
        zOrder: card.zOrder || state.nextZOrder++,
        // An agent-spawned card must carry its home dashboard or it renders on EVERY dashboard; trust the backend's tag, fall back to the current dashboard so an old/untagged payload can't bleed.
        dashboard_id: card.dashboard_id ?? getLastDashboardId() ?? undefined,
      };
      ledgerAdd(state.creationOrder, card.browser_id);
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
      delete state.endingBrowserCards[action.payload];
      delete state.tiledCards[action.payload];
      delete state.minimizedCards[action.payload];
      delete state.zOrders[action.payload];
      ledgerRemove(state.creationOrder, action.payload);
    },

    markBrowserCardEnding(
      state, action: PayloadAction<{ browserId: string; status: 'completed' | 'error' }>,
    ) {
      if (!state.browserCards[action.payload.browserId]) return;
      state.endingBrowserCards[action.payload.browserId] = {
        status: action.payload.status,
        at: Date.now(),
      };
    },

    cancelBrowserCardEnding(state, action: PayloadAction<string>) {
      delete state.endingBrowserCards[action.payload];
    },

    keepBrowserCardOpen(state, action: PayloadAction<string>) {
      const card = state.browserCards[action.payload];
      if (!card) return;
      card.keep_open = true;
      // Undo any in-flight ending mark in case a close path raced ahead.
      delete state.endingBrowserCards[action.payload];
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
      // Fall back to persistedExpandedSessionIds when the caller didn't wire the live list through. Without it, collectOccupiedRects sees every chat at its stored (collapsed) height, and a workflow spawned from an open chat lands on top of the visibly-tall card.
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
      // Rule 7: a dead card must never keep owning a tile; a stale entry poisons every reader of it.
      delete state.tiledCards[action.payload];
      delete state.minimizedCards[action.payload];
      ledgerRemove(state.creationOrder, action.payload);
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
      ledgerRekey(state.creationOrder, oldId, newId);
      if (state.pendingFocusWorkflowId === oldId) state.pendingFocusWorkflowId = newId;
    },

    clearPendingFocusWorkflowId(state) {
      state.pendingFocusWorkflowId = null;
    },

    openWorkflowsHub(state, action: PayloadAction<{ expandedSessionIds?: string[] } | undefined>) {
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

    clearPendingFocusWorkflowsHub(state) {
      state.pendingFocusWorkflowsHub = false;
    },

    closeWorkflowsHub(state) {
      state.workflowsHub = null;
      delete state.minimizedCards[WORKFLOWS_HUB_ID];
      delete state.tiledCards[WORKFLOWS_HUB_ID];
    },

    // The Workflows app is an on-canvas card (like chat/browser/view cards), backed by the singleton workflowsHub geometry. Opening it creates or raises that card and pans to it; an optional workflowId deep-links to that workflow's detail once the card mounts.
    openWorkflowsApp(state, action: PayloadAction<{ workflowId?: string; expandedSessionIds?: string[] } | undefined>) {
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

    closeWorkflowsApp(state) {
      state.workflowsHub = null;
      delete state.tiledCards[WORKFLOWS_HUB_ID];
      delete state.minimizedCards[WORKFLOWS_HUB_ID];
      state.workflowsAppTarget = null;
      state.workflowsMonitorId = null;
      state.workflowsMonitorRunId = null;
      state.workflowsMonitorCard = null;
    },

    clearWorkflowsAppTarget(state) {
      state.workflowsAppTarget = null;
    },

    // Spawn the Run Monitor as a real canvas card to the right of the window, tethered back to it. Reuses the window's geometry to place + size it. runId pins a specific (e.g. history) run; omit it to follow the latest.
    openWorkflowMonitor(state, action: PayloadAction<{ workflowId: string; runId?: string }>) {
      state.workflowsMonitorId = action.payload.workflowId;
      state.workflowsMonitorRunId = action.payload.runId ?? null;
      const hub = state.workflowsHub;
      // Keep the existing card position when just switching the run shown.
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

    closeWorkflowMonitor(state) {
      state.workflowsMonitorId = null;
      state.workflowsMonitorRunId = null;
      state.workflowsMonitorCard = null;
    },

    setWorkflowsMonitorPosition(state, action: PayloadAction<{ x: number; y: number }>) {
      if (!state.workflowsMonitorCard) return;
      state.workflowsMonitorCard.x = action.payload.x;
      state.workflowsMonitorCard.y = action.payload.y;
    },

    setWorkflowsRunContext(state, action: PayloadAction<WorkflowsRunContext>) {
      state.workflowsRunContext = action.payload;
    },

    clearWorkflowsRunContext(state) {
      state.workflowsRunContext = null;
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

    // Settings is an on-canvas window like the Workflows app, not a modal: opening it creates or raises that card and pans to it.
    openSettingsCard(state, action: PayloadAction<{ tab?: string; expandedSessionIds?: string[] } | undefined>) {
      state.settingsRequestedTab = action.payload?.tab ?? null;
      if (state.settingsCard) {
        state.settingsCard.zOrder = state.nextZOrder++;
        delete state.minimizedCards[SETTINGS_CARD_ID];
        state.pendingFocusSettingsCard = true;
        return;
      }
      const rects = collectOccupiedRects(state, action.payload?.expandedSessionIds);
      const pos = findOpenGridCell(rects, DEFAULT_SETTINGS_CARD_W, DEFAULT_SETTINGS_CARD_H);
      state.settingsCard = {
        x: pos.x,
        y: pos.y,
        width: DEFAULT_SETTINGS_CARD_W,
        height: DEFAULT_SETTINGS_CARD_H,
        zOrder: state.nextZOrder++,
      };
      state.pendingFocusSettingsCard = true;
    },

    closeSettingsCard(state) {
      state.settingsCard = null;
      state.settingsRequestedTab = null;
      delete state.minimizedCards[SETTINGS_CARD_ID];
      delete state.tiledCards[SETTINGS_CARD_ID];
      state.pendingFocusSettingsCard = false;
    },

    clearPendingFocusSettingsCard(state) {
      state.pendingFocusSettingsCard = false;
    },

    clearSettingsRequestedTab(state) {
      state.settingsRequestedTab = null;
    },

    setSettingsCardPosition(state, action: PayloadAction<{ x: number; y: number }>) {
      if (!state.settingsCard) return;
      state.settingsCard.x = action.payload.x;
      state.settingsCard.y = action.payload.y;
    },

    setSettingsCardSize(state, action: PayloadAction<{ width: number; height: number }>) {
      if (!state.settingsCard) return;
      state.settingsCard.width = Math.max(640, action.payload.width);
      state.settingsCard.height = Math.max(460, action.payload.height);
    },

    // Marketplace mirrors the Settings window: an on-canvas singleton, opened or raised in place.
    openMarketplaceCard(state, action: PayloadAction<{ tab?: string; expandedSessionIds?: string[] } | undefined>) {
      state.marketplaceRequestedTab = action.payload?.tab ?? null;
      if (state.marketplaceCard) {
        state.marketplaceCard.zOrder = state.nextZOrder++;
        delete state.minimizedCards[MARKETPLACE_CARD_ID];
        state.pendingFocusMarketplaceCard = true;
        return;
      }
      const rects = collectOccupiedRects(state, action.payload?.expandedSessionIds);
      const pos = findOpenGridCell(rects, DEFAULT_MARKETPLACE_CARD_W, DEFAULT_MARKETPLACE_CARD_H);
      state.marketplaceCard = {
        x: pos.x,
        y: pos.y,
        width: DEFAULT_MARKETPLACE_CARD_W,
        height: DEFAULT_MARKETPLACE_CARD_H,
        zOrder: state.nextZOrder++,
      };
      state.pendingFocusMarketplaceCard = true;
    },

    closeMarketplaceCard(state) {
      state.marketplaceCard = null;
      state.marketplaceRequestedTab = null;
      delete state.minimizedCards[MARKETPLACE_CARD_ID];
      delete state.tiledCards[MARKETPLACE_CARD_ID];
      state.pendingFocusMarketplaceCard = false;
    },

    clearPendingFocusMarketplaceCard(state) {
      state.pendingFocusMarketplaceCard = false;
    },

    clearMarketplaceRequestedTab(state) {
      state.marketplaceRequestedTab = null;
    },

    setMarketplaceCardPosition(state, action: PayloadAction<{ x: number; y: number }>) {
      if (!state.marketplaceCard) return;
      state.marketplaceCard.x = action.payload.x;
      state.marketplaceCard.y = action.payload.y;
    },

    setMarketplaceCardSize(state, action: PayloadAction<{ width: number; height: number }>) {
      if (!state.marketplaceCard) return;
      state.marketplaceCard.width = Math.max(760, action.payload.width);
      state.marketplaceCard.height = Math.max(520, action.payload.height);
    },

    pasteBrowserCard(
      state,
      action: PayloadAction<{
        tabs: BrowserTab[]; url: string; expandedSessionIds?: string[];
        id?: string; x?: number; y?: number; width?: number; height?: number;
        dockTo?: string | null;
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
        // Pasted onto the dashboard the user is looking at, else it bleeds onto every dashboard.
        dashboard_id: getLastDashboardId() ?? undefined,
        // When the copied browser belonged to a copied agent, dock it inline under the NEW agent so
        // the paste looks like the original instead of a stray full-size canvas browser (ENG-250).
        spawned_by: action.payload.dockTo || null,
        docked_to: (action.payload.dockTo && (clearOtherDocks(state, action.payload.dockTo), action.payload.dockTo)) || null,
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

    // Ctrl+Tab / Ctrl+Shift+Tab: move to the next/previous tab, wrapping around. dir 1 = forward.
    cycleBrowserTab(
      state,
      action: PayloadAction<{ browserId: string; dir: 1 | -1 }>
    ) {
      const card = state.browserCards[action.payload.browserId];
      if (!card || card.tabs.length < 2) return;
      const idx = card.tabs.findIndex((t) => t.id === card.activeTabId);
      if (idx === -1) return;
      const n = card.tabs.length;
      const next = card.tabs[(idx + action.payload.dir + n) % n];
      card.activeTabId = next.id;
      card.url = next.url;
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

    // Drag a tab OUT of a browser card: into another card (absorbed, appended + activated) or onto empty canvas (spins off a new card at the drop point). Moving the last tab dissolves the source card, Chrome-style.
    moveBrowserTab(
      state,
      action: PayloadAction<{ fromBrowserId: string; tabId: string; toBrowserId?: string; x?: number; y?: number }>
    ) {
      const { fromBrowserId, tabId, toBrowserId, x, y } = action.payload;
      if (toBrowserId === fromBrowserId) return;
      const source = state.browserCards[fromBrowserId];
      if (!source) return;
      const idx = source.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      const target = toBrowserId ? state.browserCards[toBrowserId] : undefined;
      if (toBrowserId && !target) return;
      const [moved] = source.tabs.splice(idx, 1);
      // Fresh id: reusing the old one makes the receiving BrowserCard think the tab is already initialized, so its webview never loads the URL and sits at about:blank.
      const tab = { ...moved, id: generateTabId() };
      const spun = {
        owner: source.spawned_by ?? null,
        x: source.x, y: source.y, width: source.width, height: source.height, dashboard_id: source.dashboard_id,
      };
      const dissolved = source.tabs.length === 0;
      if (dissolved) {
        delete state.browserCards[fromBrowserId];
        delete state.suspendedBrowserCards[fromBrowserId];
      } else if (source.activeTabId === tabId) {
        const nextActive = source.tabs[Math.min(idx, source.tabs.length - 1)];
        source.activeTabId = nextActive.id;
        source.url = nextActive.url;
      }
      if (target) {
        target.tabs.push(tab);
        target.activeTabId = tab.id;
        target.url = tab.url;
        target.zOrder = state.nextZOrder++;
      } else {
        // The last tab leaving is the card MOVING, so it keeps its id; either way it keeps its agent
        // owner, or the agent stops recognising its own browser and spawns a second one next time it
        // browses. keep_open because pulling it out is the user claiming it: the owner finishing must
        // not delete it out from under them, exactly as when it had no owner at all.
        const id = dissolved ? fromBrowserId : `browser-${Date.now().toString(36)}`;
        state.browserCards[id] = {
          browser_id: id,
          url: tab.url,
          tabs: [tab],
          activeTabId: tab.id,
          x: x ?? spun.x + 60,
          y: y ?? spun.y + 60,
          width: spun.width,
          height: spun.height,
          zOrder: state.nextZOrder++,
          dashboard_id: spun.dashboard_id,
          spawned_by: spun.owner,
          keep_open: true,
        };
      }
    },

    moveCards(
      state,
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
        } else if (item.type === 'workflows-hub') {
          if (state.workflowsHub) {
            state.workflowsHub.x += dx;
            state.workflowsHub.y += dy;
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
        } else {
          const card = state.browserCards[item.id];
          if (card) {
            card.x += dx;
            card.y += dy;
          }
        }
      }
    },

    // Snapshot a card onto the reopen stack RIGHT BEFORE it's closed (the data must still be in state). Dispatch only from genuine user closes, not programmatic teardown.
    recordClosedCard(
      state,
      action: PayloadAction<{ kind: ClosedCardKind; id: string; browserId?: string }>
    ) {
      const { kind, id, browserId } = action.payload;
      const closedAt = Date.now();
      const uid = `${kind}-${id}-${closedAt}`;
      let entry: ClosedCard | null = null;
      if (kind === 'browser' && state.browserCards[id]) {
        entry = { uid, kind, closedAt, card: { ...state.browserCards[id], tabs: state.browserCards[id].tabs.map((t) => ({ ...t })) } };
      } else if (kind === 'view' && state.viewCards[id]) {
        entry = { uid, kind, closedAt, card: { ...state.viewCards[id] } };
      } else if (kind === 'workflow' && state.workflowCards[id]) {
        entry = { uid, kind, closedAt, card: { ...state.workflowCards[id] } };
      } else if (kind === 'agent') {
        entry = { uid, kind, closedAt, sessionId: id, position: state.cards[id] ? { ...state.cards[id] } : null };
      } else if (kind === 'tab' && browserId && state.browserCards[browserId]) {
        const card = state.browserCards[browserId];
        const index = card.tabs.findIndex((t) => t.id === id);
        // Last tab closing tears the whole card down; that's recorded as a 'browser' close instead, so skip.
        if (index >= 0 && card.tabs.length > 1) entry = { uid, kind, closedAt, browserId, index, tab: { ...card.tabs[index] } };
      }
      if (!entry) return;
      state.recentlyClosed.push(entry);
      if (state.recentlyClosed.length > RECENTLY_CLOSED_CAP) state.recentlyClosed.shift();
    },

    // Re-insert a non-agent closed card (agents come back via resumeSession in the reopenLastClosed thunk). Lands on the current dashboard.
    restoreClosedCard(
      state,
      action: PayloadAction<{ entry: ClosedCard; dashboardId?: string }>
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
          // Fresh id: reusing the old one makes BrowserCard think the tab is already initialized, so its webview never reloads the URL and sits at about:blank.
          const tab = { ...entry.tab, id: generateTabId() };
          card.tabs.splice(Math.min(entry.index, card.tabs.length), 0, tab);
          card.activeTabId = tab.id;
          card.url = tab.url;
        }
      }
    },

    popClosedCard(state, action: PayloadAction<string>) {
      state.recentlyClosed = state.recentlyClosed.filter((e) => e.uid !== action.payload);
    },

    // Pre-seed a resumed agent's old position so reconcileSessions drops its card back where it was, not in a fresh grid cell.
    seedClosedAgentPosition(
      state,
      action: PayloadAction<{ sessionId: string; position: CardPosition }>
    ) {
      rememberClosedPosition(state.closedCardPositions, action.payload.sessionId, action.payload.position);
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

    resetLayout(state, action: PayloadAction<{ keepBrowserIds?: string[] } | undefined>) {
      state.tiledCards = {};
      state.minimizedCards = {};
      // Keep the recently-used (keep-alive) browser cards mounted across a dashboard switch so their webContents + sessionStorage survive (logged-in sites stay logged in); everything else is wiped for the fresh load. Their suspend entry rides along so a parked one isn't silently dropped.
      const keep = new Set(action.payload?.keepBrowserIds || []);
      const keptBrowsers: typeof state.browserCards = {};
      const keptSuspended: typeof state.suspendedBrowserCards = {};
      for (const id of keep) {
        if (state.browserCards[id]) keptBrowsers[id] = state.browserCards[id];
        if (state.suspendedBrowserCards[id]) keptSuspended[id] = state.suspendedBrowserCards[id];
      }
      state.cards = {};
      state.viewCards = {};
      state.browserCards = keptBrowsers;
      state.workflowCards = {};
      state.workflowsHub = null;
      state.settingsCard = null;
      state.pendingFocusSettingsCard = false;
      state.settingsRequestedTab = null;
      state.marketplaceCard = null;
      state.pendingFocusMarketplaceCard = false;
      state.marketplaceRequestedTab = null;
      state.closedCardPositions = {};
      state.glowingBrowserCards = {};
      state.glowingAgentCards = {};
      state.persistedExpandedSessionIds = [];
      state.nextZOrder = 1;
      state.initialized = false;
      state.saveArmed = false;
      state.suspendedBrowserCards = keptSuspended;
      state.endingBrowserCards = {};
      state.pendingFocusWorkflowId = null;
      // Per-dashboard, same as the cards it tracks; fetchLayout.fulfilled rebuilds it for the new dashboard.
      state.creationOrder = [];
    },

  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchLayout.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchLayout.fulfilled, (state, action) => {
        state.loading = false;
        // A fresh mount/switch load replaces (the snapshot is the user's saved layout, authoritative). A reconnect refetch (useDashboardLifecycle line ~90) recovers cards lost in a socket gap and must MERGE, blind- replacing there clobbered the live, collision-placed positions of cards already on canvas (the overlap / vanish under load while many browsers spawn). The caller says which; never inferred from state.
        const isReconnectRefetch = action.meta.arg.isReconnect === true;
        state.initialized = true;
        state.saveArmed = true;
        const ownerDashboardId = action.meta.arg.dashboardId;
        if (!isReconnectRefetch) {
          state.cards = action.payload.cards;
          state.viewCards = action.payload.viewCards;
          // Merge, don't replace: the keep-alive browser cards resetLayout preserved are ALREADY in state.browserCards with their webContents live. Keep them and add this dashboard's saved cards on top; on overlap (switching back to their own dashboard) the live data wins so the mounted webview isn't disturbed.
          const keptAlive = state.browserCards;
          const incoming = action.payload.browserCards;
          // Default a missing home to the dashboard we're loading (legacy/untagged cards), but DON'T overwrite a real persisted home: a card saved here yet owned elsewhere is leftover from the old untagged-shows-everywhere bug, leaving its true home lets it park off-screen and get cleaned on the next save instead of bleeding.
          for (const card of Object.values(incoming)) {
            if (!card.dashboard_id) card.dashboard_id = ownerDashboardId;
          }
          // New cards boot parked (no guest process, title placeholder); the suspend hook wakes viewport-sized and agent-driven ones on its first pass. NEVER re-park a live keep-alive card, that snapshot-swap would kill its session.
          for (const id of Object.keys(incoming)) {
            if (keptAlive[id] === undefined) state.suspendedBrowserCards[id] = { dataUrl: '', capturedAt: 0 };
          }
          state.browserCards = { ...incoming, ...keptAlive };
          state.workflowCards = action.payload.workflowCards || {};
          state.workflowsHub = action.payload.workflowsHub || null;
          // The wholesale replace bypasses every removal reducer, so window-state entries can orphan; a stale 'fullscreen' re-engages the moment the same id reappears, hiding all chrome with zero clicks.
          for (const id of Object.keys(state.tiledCards)) {
            if (!tileOwnerExists(state, id)) delete state.tiledCards[id];
          }
          // Safe mode (ENG-228): after repeated dirty exits, every browser webview boots parked as a screenshot; clicking a card resumes it (the existing suspend/resume path), so a crash loop can't rebuild the surface storm that killed the last session.
          if (isSafeMode()) {
            for (const id of Object.keys(state.browserCards)) {
              if (!state.suspendedBrowserCards[id]) state.suspendedBrowserCards[id] = { dataUrl: '', capturedAt: 0 };
            }
          }
          // Pre-1.7.6 profiles can persist several live 'fullscreen' entries; the selector crowns the first, so every OTHER card's drag guard compares against the wrong owner and lets the drag through. One owner, same rule as the write reducer.
          let fsOwner: string | null = null;
          for (const [id, zone] of Object.entries(state.tiledCards)) {
            if (zone !== 'fullscreen') continue;
            if (fsOwner === null) { fsOwner = id; continue; }
            delete state.tiledCards[id];
          }
          for (const id of Object.keys(state.minimizedCards)) {
            if (!tileOwnerExists(state, id)) delete state.minimizedCards[id];
          }
        } else {
          const occupied = collectOccupiedRects(state, action.payload.expandedSessionIds);
          addMissingCards(state.cards, action.payload.cards, occupied);
          addMissingCards(state.viewCards, action.payload.viewCards, occupied);
          addMissingCards(state.browserCards, action.payload.browserCards, occupied);
          for (const card of Object.values(state.browserCards)) {
            if (!card.dashboard_id) card.dashboard_id = ownerDashboardId;
          }
          addMissingCards(state.workflowCards, action.payload.workflowCards || {}, occupied);
          if (!state.workflowsHub && action.payload.workflowsHub) state.workflowsHub = action.payload.workflowsHub;
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
        for (const w of Object.values(state.workflowCards)) {
          if (!w.zOrder) w.zOrder = 0;
          if (w.zOrder > maxZ) maxZ = w.zOrder;
        }
        state.zOrders = { ...state.zOrders, ...(action.payload.zOrders ?? {}) };
        for (const z of Object.values(state.zOrders)) { if (z > maxZ) maxZ = z; }
        state.nextZOrder = maxZ + 1;

        // Ledger rebuild: persisted order filtered to live ids, then unledgered survivors by zOrder (legacy layouts, drift). Keep-alive browsers homed on OTHER dashboards stay out: the trash must never delete a card the user can't see.
        const zOf = (id: string): number =>
          state.zOrders[id] ?? state.cards[id]?.zOrder ?? state.viewCards[id]?.zOrder ?? state.browserCards[id]?.zOrder ?? state.workflowCards[id]?.zOrder ?? 0;
        const live = new Set<string>([
          ...Object.keys(state.cards),
          ...Object.keys(state.viewCards),
          ...Object.keys(state.workflowCards),
          ...Object.entries(state.browserCards)
            .filter(([, bc]) => !bc.dashboard_id || bc.dashboard_id === ownerDashboardId)
            .map(([id]) => id),
        ]);
        const persisted = action.payload.creationOrder.filter((id) => live.has(id));
        const ledgered = new Set(persisted);
        const rest = [...live].filter((id) => !ledgered.has(id)).sort((a, b) => zOf(a) - zOf(b));
        state.creationOrder = [...persisted, ...rest];
      })
      .addCase(fetchLayout.rejected, (state) => {
        state.loading = false;
        // Fail-open for RENDERING only; saveArmed stays false so this client can never persist the empty layout it booted with over the server's real one (the wipe that hit 2026-07-20).
        state.initialized = true;
      })
      // Rule 8 of the tiling set: a chat's zone belongs to its OPEN state, so every action that closes
      // chats untiles them here, in the same dispatch. See untileClosedChats.
      .addCase(collapseSession, (state, action) => {
        untileClosedChats(state.tiledCards, [action.payload], []);
      })
      .addCase(collapseAllSessions, (state) => {
        untileClosedChats(state.tiledCards, Object.keys(state.cards), []);
      })
      .addCase(setExpandedSessionIds, (state, action) => {
        untileClosedChats(state.tiledCards, Object.keys(state.cards), action.payload);
      })
      .addCase(fetchSessionRejectedAction, (state, action) => {
        // 404/410 means permanent; strip the card. Other failure modes leave it (next fetch may succeed).
        const payload = action.payload;
        if (!payload?.sessionId) return;
        if (payload.status !== 404 && payload.status !== 410) return;
        const id = payload.sessionId;
        if (state.cards[id]) delete state.cards[id];
        if (state.closedCardPositions[id]) delete state.closedCardPositions[id];
        ledgerRemove(state.creationOrder, id);
      })
      .addCase(deleteWorkflowFulfilledAction, (state, action) => {
        const id = action.payload;
        if (id && state.workflowCards[id]) delete state.workflowCards[id];
        if (id) ledgerRemove(state.creationOrder, id);
      })
      .addCase(launchAndSendFirstMessage.fulfilled, (state, action) => {
        const { draftId, session } = action.payload;
        const card = state.cards[draftId];
        if (card) {
          delete state.cards[draftId];
          state.cards[session.id] = { ...card, session_id: session.id, zOrder: state.nextZOrder++ };
          ledgerRekey(state.creationOrder, draftId, session.id);
        }
        // The zone rides the re-key too: left behind, a tiled draft pops out of its tile AND strands an
        // entry no reader can ever clear (a stranded 'fullscreen' hides the whole shell until reload).
        const draftZone = state.tiledCards[draftId];
        if (draftZone) {
          delete state.tiledCards[draftId];
          state.tiledCards[session.id] = draftZone;
        }
        // Carry an optimistic browser tether from the draft id to the real session id, in place (no flicker, no stale draft endpoint).
        for (const entry of Object.values(state.glowingBrowserCards)) {
          if (entry.sourceId === draftId) entry.sourceId = session.id;
        }
        // First-turn browser race: a browser the first message spawns carries parent_session_id = the real id, so its browser_card_added can land BEFORE this re-key, find no parent card, and fall back to the grid. Now that the chat card exists under the real id, dock each such browser beside it (freshly spawned, so not user-moved yet) and restore the tether the racing path skipped.
        const parentCard = state.cards[session.id];
        if (parentCard) {
          for (const bc of Object.values(state.browserCards)) {
            if (bc.spawned_by !== session.id) continue;
            const pos = placeBrowserBesideChat(state, parentCard, session.id, bc.width, bc.height, bc.browser_id);
            // Default home is inside the chat, same as the non-racing spawn path.
            clearOtherDocks(state, session.id);
            bc.docked_to = session.id;
            bc.x = pos.x;
            bc.y = pos.y;
            state.glowingBrowserCards[bc.browser_id] = { sourceId: session.id, fading: false, label: 'Use Browser' };
          }
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
  setActiveViewCardId,
  addBrowserCard,
  addBrowserCardFromBackend,
  setBrowserDocked,
  setViewDocked,
  setBrowserCardPosition,
  setBrowserCardSize,
  removeBrowserCard,
  suspendBrowserCard,
  resumeBrowserCard,
  markBrowserCardEnding,
  cancelBrowserCardEnding,
  keepBrowserCardOpen,
  pasteBrowserCard,
  updateBrowserCardUrl,
  addBrowserTab,
  removeBrowserTab,
  setActiveBrowserTab,
  cycleBrowserTab,
  updateBrowserTabUrl,
  updateBrowserTabTitle,
  updateBrowserTabFavicon,
  reorderBrowserTab,
  moveBrowserTab,
  moveCards,
  setGlowingBrowserCards,
  fadeGlowingBrowserCards,
  clearGlowingBrowserCards,
  clearAllGlowingBrowserCards,
  setGlowingAgentCard,
  fadeGlowingAgentCard,
  clearGlowingAgentCard,
  toggleMinimizeCard,
  setTiledCard,
  clearTiledCard,
  clearAllTiles,
  clearCardWindowState,
  clearPendingFocusBrowserId,
  focusBrowserCard,
  focusViewCard,
  activateViewCardPreview,
  clearPendingFocusViewCardId,
  addWorkflowCard,
  setWorkflowCardPosition,
  setWorkflowCardSize,
  removeWorkflowCard,
  rekeyWorkflowCard,
  clearPendingFocusWorkflowId,
  openWorkflowsHub,
  closeWorkflowsHub,
  openWorkflowsApp,
  closeWorkflowsApp,
  clearWorkflowsAppTarget,
  openWorkflowMonitor,
  closeWorkflowMonitor,
  setWorkflowsMonitorPosition,
  setWorkflowsRunContext,
  clearWorkflowsRunContext,
  setWorkflowsHubPosition,
  setWorkflowsHubSize,
  clearPendingFocusWorkflowsHub,
  openSettingsCard,
  closeSettingsCard,
  openMarketplaceCard,
  closeMarketplaceCard,
  clearPendingFocusMarketplaceCard,
  clearMarketplaceRequestedTab,
  setMarketplaceCardPosition,
  setMarketplaceCardSize,
  clearPendingFocusSettingsCard,
  clearSettingsRequestedTab,
  setSettingsCardPosition,
  setSettingsCardSize,
  recordClosedCard,
  restoreClosedCard,
  popClosedCard,
  seedClosedAgentPosition,
  resetLayout,
} = dashboardLayoutSlice.actions;

// Ctrl/Cmd+Shift+T: bring back the most recently closed card on the current dashboard. Agents resume from history (async); everything else is a synchronous re-insert. Best-effort: the entry is consumed even if an agent resume fails, so a dead session can't wedge the stack.
export const reopenLastClosed = createAsyncThunk(
  'dashboardLayout/reopenLastClosed',
  async (_: void, { getState, dispatch }) => {
    const state = getState() as { dashboardLayout: DashboardLayoutState };
    const stack = state.dashboardLayout.recentlyClosed;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    const dashboardId = getLastDashboardId() ?? undefined;
    if (entry.kind === 'agent') {
      if (entry.position) dispatch(seedClosedAgentPosition({ sessionId: entry.sessionId, position: entry.position }));
      await dispatch(resumeSession({ sessionId: entry.sessionId }));
    } else {
      dispatch(restoreClosedCard({ entry, dashboardId }));
    }
    dispatch(popClosedCard(entry.uid));
  }
);

// A card in the `fill` zone covers the whole viewport just like `fullscreen` does, but it is not
// 'fullscreen', so the canvas chrome stayed up and the tidy/zoom cluster sat directly on the card's
// composer (measured: 4 controls over a filled card, 0 over a fullscreen one). Anything that hides
// chrome because a card owns the screen must ask THIS, not the fullscreen question.
export const selectViewportCoveringCardId = (state: { dashboardLayout: DashboardLayoutState }): string | null => {
  const s = state.dashboardLayout;
  const entry = Object.entries(s.tiledCards).find(([, zone]) => zone === 'fullscreen' || zone === 'fill');
  if (!entry) return null;
  const id = entry[0];
  return tileOwnerExists(s, id) && !s.minimizedCards[id] ? id : null;
};

export const selectFullscreenCardId = (state: { dashboardLayout: DashboardLayoutState }): string | null => {
  const s = state.dashboardLayout;
  const entry = Object.entries(s.tiledCards).find(([, zone]) => zone === 'fullscreen');
  if (!entry) return null;
  const id = entry[0];
  // Belt over the reducer hygiene: an entry whose card is gone (any removal path) must not hold the app in fullscreen.
  return tileOwnerExists(s, id) && !s.minimizedCards[id] ? id : null;
};

export default dashboardLayoutSlice.reducer;
