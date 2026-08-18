export const DEFAULT_CARD_W = 480;
export const DEFAULT_CARD_H = 280;
export const DEFAULT_VIEW_CARD_W = 1280;
export const DEFAULT_VIEW_CARD_H = 800;
export const DEFAULT_BROWSER_CARD_W = 1280;
export const DEFAULT_BROWSER_CARD_H = 800;
export const DEFAULT_SETTINGS_CARD_W = DEFAULT_BROWSER_CARD_W;
export const DEFAULT_SETTINGS_CARD_H = DEFAULT_BROWSER_CARD_H;
export const WORKFLOWS_HUB_ID = 'workflows-hub';
export const SETTINGS_CARD_ID = 'settings';
export const MARKETPLACE_CARD_ID = 'marketplace';
export const DEFAULT_MARKETPLACE_CARD_W = DEFAULT_BROWSER_CARD_W;
export const DEFAULT_MARKETPLACE_CARD_H = DEFAULT_BROWSER_CARD_H;
export const DEFAULT_WORKFLOW_CARD_W = 480;
export const DEFAULT_WORKFLOW_CARD_H = 520;
// Open at the same default footprint as a browser/view card so it lands at a comfortable size automatically.
export const DEFAULT_WORKFLOWS_HUB_W = DEFAULT_BROWSER_CARD_W;
export const DEFAULT_WORKFLOWS_HUB_H = DEFAULT_BROWSER_CARD_H;
export const EXPANDED_CARD_MIN_H = 620;
export const GRID_GAP = 24;
// Gap between the Workflows window and the cards it spawns (run monitor, that monitor's browser). Keeps the hub -> monitor -> browser row evenly spaced.
export const WORKFLOW_CARD_GAP = 140;

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
  /** Chat this view card is parked inside while that chat is expanded; null/undefined = free on the canvas. */
  docked_to?: string | null;
  /** A view card whose live preview has not been activated yet (serve-static / lazy boot). */
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
  /** Chat this browser is parked inside while that chat is expanded; null/undefined = free on the canvas. */
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

export const RECENTLY_CLOSED_CAP = 25;

export interface DashboardLayoutState {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  /** Unrecognized persisted layout partitions retained per dashboard for forward/legacy compatibility. */
  unknownPersistedLayoutFieldsByDashboard: Record<string, Record<string, unknown>>;
  closedCardPositions: Record<string, CardPosition>;
  /** Session-global LIFO undo stack for Ctrl/Cmd+Shift+T; survives dashboard switches (resetLayout leaves it alone). */
  recentlyClosed: ClosedCard[];
  glowingBrowserCards: Record<string, { sourceId: string; fading: boolean; label?: string }>;
  glowingAgentCards: Record<string, { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string }>;
  persistedExpandedSessionIds: string[];
  nextZOrder: number;
  loading: boolean;
  initialized: boolean;
  /** Dashboard whose latest layout request may update the global canvas. */
  activeFetchDashboardId: string | null;
  /** Exact latest request generation for activeFetchDashboardId. */
  activeFetchRequestId: string | null;
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
  /** Cards parked in the minimize rail; the card renders off-canvas behind a frozen still. */
  minimizedCards: Record<string, boolean>;
  /** cardId -> tile zone; a tiled card is pinned to a screen zone until cleared. */
  tiledCards: Record<string, string>;
  /** False until a fetch has succeeded once; save() refuses to persist an un-hydrated (default) layout. */
  saveArmed: boolean;
  settingsCard: WorkflowsHubPosition | null;
  pendingFocusSettingsCard: boolean;
  settingsRequestedTab: string | null;
  marketplaceCard: WorkflowsHubPosition | null;
  pendingFocusMarketplaceCard: boolean;
  marketplaceRequestedTab: string | null;
  /** Focus bumps write here instead of into the card dicts, so a click never re-identifies a card and arms a layout PUT. */
  zOrders: Record<string, number>;
  /** Card ids in creation order; persisted so the dock/rail can order without timestamps. */
  creationOrder: string[];
}

export interface WorkflowsRunContext {
  workflowId: string;
  runId: string;
  title: string;
  metaLabel: string;
  color: string;
}

export const initialDashboardLayoutState: DashboardLayoutState = {
  cards: {},
  viewCards: {},
  browserCards: {},
  workflowCards: {},
  workflowsHub: null,
  unknownPersistedLayoutFieldsByDashboard: {},
  closedCardPositions: {},
  recentlyClosed: [],
  glowingBrowserCards: {},
  glowingAgentCards: {},
  persistedExpandedSessionIds: [],
  nextZOrder: 1,
  loading: false,
  initialized: false,
  activeFetchDashboardId: null,
  activeFetchRequestId: null,
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
  minimizedCards: {},
  tiledCards: {},
  saveArmed: false,
  settingsCard: null,
  pendingFocusSettingsCard: false,
  settingsRequestedTab: null,
  marketplaceCard: null,
  pendingFocusMarketplaceCard: false,
  marketplaceRequestedTab: null,
  creationOrder: [],
  zOrders: {},
};
