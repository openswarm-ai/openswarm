import { createSlice, createAsyncThunk, PayloadAction, createAction } from '@reduxjs/toolkit';
import { isSafeMode } from '@/shared/safeMode';
import { launchAndSendFirstMessage, resumeSession, collapseSession, collapseAllSessions, setExpandedSessionIds } from './agentsSlice';
import { untileClosedChats } from './untileClosedChats';
import { API_BASE } from '@/shared/config';
import { getLastDashboardId } from '@/shared/lastDashboardId';
import {
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  initialDashboardLayoutState,
  type BrowserCardPosition,
  type CardPosition,
  type DashboardLayoutState,
  type ViewCardPosition,
  type WorkflowCardPosition,
  type WorkflowsHubPosition,
} from './dashboardLayoutModel';
import {
  collectOccupiedRects,
  findOpenGridCell,
  findOpenSpotNear,
  placeBrowserBesideChat,
  type Rect,
} from './dashboardLayoutGeometry';
import { agentCardReducers } from './dashboardLayoutAgentReducers';
import { browserCardReducers, generateTabId } from './dashboardLayoutBrowserReducers';
import { canvasReducers } from './dashboardLayoutCanvasReducers';
import { closedCardReducers } from './dashboardLayoutClosedReducers';
import { glowReducers } from './dashboardLayoutGlowReducers';
import { resetReducers } from './dashboardLayoutResetReducers';
import { tileOwnerExists, windowCardReducers } from './dashboardLayoutWindowReducers';
import { viewCardReducers } from './dashboardLayoutViewReducers';
import { workflowCardReducers } from './dashboardLayoutWorkflowReducers';
import { ledgerRekey, ledgerRemove, reconcileDashboardCardZOrder } from './dashboardLayoutCardState';

export {
  DEFAULT_BROWSER_CARD_H,
  DEFAULT_BROWSER_CARD_W,
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  DEFAULT_MARKETPLACE_CARD_H,
  DEFAULT_MARKETPLACE_CARD_W,
  DEFAULT_SETTINGS_CARD_H,
  DEFAULT_SETTINGS_CARD_W,
  DEFAULT_VIEW_CARD_H,
  DEFAULT_VIEW_CARD_W,
  DEFAULT_WORKFLOW_CARD_H,
  DEFAULT_WORKFLOW_CARD_W,
  DEFAULT_WORKFLOWS_HUB_H,
  DEFAULT_WORKFLOWS_HUB_W,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  MARKETPLACE_CARD_ID,
  SETTINGS_CARD_ID,
  WORKFLOW_CARD_GAP,
  WORKFLOWS_HUB_ID,
  viewCardKey,
} from './dashboardLayoutModel';
export type {
  BrowserCardPosition,
  BrowserTab,
  CardPosition,
  CardType,
  ClosedCard,
  ClosedCardKind,
  DashboardLayoutState,
  ViewCardPosition,
  WorkflowCardPosition,
  WorkflowsHubPosition,
  WorkflowsRunContext,
} from './dashboardLayoutModel';
export {
  computeSpawnPosition,
  findOpenGridCell,
  findOpenSpotNear,
  placeBesideCard,
  placeBelowCard,
  placeBrowserBesideChat,
  placeInParentColumn,
} from './dashboardLayoutGeometry';
export type { SpawnAnchor } from './dashboardLayoutGeometry';

// fetchSession 404/410 strips the layout card to stop AgentChat remount-loop. Matched by string to avoid circular import.
const fetchSessionRejectedAction = createAction<
  { sessionId?: string; status?: number } | undefined
>('agents/fetchSession/rejected');

// Cascade workflow delete to layout so the "Make workflow" tether stops pointing at empty space.
const deleteWorkflowFulfilledAction = createAction<string>('workflows/delete/fulfilled');

const DASHBOARDS_API = `${API_BASE}/dashboards`;

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : `${fallback}: ${res.status}`;
    throw new Error(detail);
  }
  return data as T;
}

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
  unknownPersistedLayoutFields: Record<string, unknown>;
}

const KNOWN_PERSISTED_LAYOUT_FIELDS = new Set([
  'cards',
  'view_cards',
  'browser_cards',
  'workflow_cards',
  'workflows_hub',
  'expanded_session_ids',
  'creation_order',
  'z_orders',
]);

function unknownPersistedLayoutFields(layout: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(layout).filter(([key]) => !KNOWN_PERSISTED_LAYOUT_FIELDS.has(key)),
  );
}

export const fetchLayout = createAsyncThunk(
  'dashboardLayout/fetch',
  // isReconnect distinguishes a socket-reconnect recovery refetch (merge, keep live positions) from a fresh mount/switch load (replace, snapshot is the user's saved layout). Passed explicitly, not inferred from state, so a stale in-flight fetch from a previous dashboard can't be misread as a merge.
  async ({ dashboardId }: { dashboardId: string; isReconnect?: boolean }) => {
    const res = await fetch(`${DASHBOARDS_API}/${dashboardId}`);
    const data = await readJson<{ layout?: Record<string, unknown> }>(res, 'Dashboard layout fetch failed');
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
      unknownPersistedLayoutFields: unknownPersistedLayoutFields(layout),
    } satisfies LayoutPayload;
  },
);

interface SaveLayoutPayload extends Omit<LayoutPayload, 'unknownPersistedLayoutFields'> {
  dashboardId: string;
  saveAuthority: Record<string, unknown> | undefined;
}

export const saveLayout = createAsyncThunk(
  'dashboardLayout/save',
  async (payload: SaveLayoutPayload, { getState }) => {
    const layoutState = (getState() as { dashboardLayout: DashboardLayoutState }).dashboardLayout;
    // Never persist a layout this client never successfully loaded; a failed boot fetch otherwise saves the pristine empty store over the server's real layout (the wipe class).
    if (!layoutState.saveArmed) return payload;
    // Prune focus overrides to ids that still exist, so removed cards can't grow the map forever.
    const liveZ: Record<string, number> = {};
    for (const [zid, z] of Object.entries(layoutState.zOrders)) {
      if (payload.cards[zid] || payload.viewCards[zid] || payload.browserCards[zid] || payload.workflowCards[zid]
        || zid === 'settings' || zid === 'marketplace' || zid === 'workflows-hub' || zid === 'workflows-monitor') liveZ[zid] = z;
    }
    await fetch(`${DASHBOARDS_API}/${payload.dashboardId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: {
          ...(layoutState.unknownPersistedLayoutFieldsByDashboard[payload.dashboardId] ?? {}),
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
  {
    condition: (payload, { getState }) => {
      const layoutState = (getState() as { dashboardLayout: DashboardLayoutState }).dashboardLayout;
      const currentAuthority = layoutState.unknownPersistedLayoutFieldsByDashboard[payload.dashboardId];
      // Fulfilled fetches create a new per-dashboard baseline object even when the unknown-field map is empty.
      // Identity binds delayed/unmount saves to the exact successful fetch they were captured from.
      const activeRefetchIsPending = (
        layoutState.loading
        && layoutState.activeFetchDashboardId === payload.dashboardId
      );
      return (
        !activeRefetchIsPending
        && payload.saveAuthority !== undefined
        && payload.saveAuthority === currentAuthority
      );
    },
  },
);

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


const dashboardLayoutSlice = createSlice({
  name: 'dashboardLayout',
  initialState: initialDashboardLayoutState,
  reducers: {
    ...agentCardReducers,

    ...canvasReducers,

    ...viewCardReducers,

    ...browserCardReducers,

    ...workflowCardReducers,

    ...closedCardReducers,

    ...glowReducers,

    ...resetReducers,
    ...windowCardReducers,

  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchLayout.pending, (state, action) => {
        state.loading = true;
        state.activeFetchDashboardId = action.meta.arg.dashboardId;
        state.activeFetchRequestId = action.meta.requestId;
      })
      .addCase(fetchLayout.fulfilled, (state, action) => {
        if (
          action.meta.arg.dashboardId !== state.activeFetchDashboardId
          || action.meta.requestId !== state.activeFetchRequestId
        ) return;
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
        state.unknownPersistedLayoutFieldsByDashboard[ownerDashboardId] = action.payload.unknownPersistedLayoutFields;
        state.persistedExpandedSessionIds = action.payload.expandedSessionIds;
        state.zOrders = { ...state.zOrders, ...(action.payload.zOrders ?? {}) };

        reconcileDashboardCardZOrder(state);

        // Ledger rebuild: persisted order filtered to live ids, then unledgered survivors by effective zOrder (legacy layouts, drift). Keep-alive browsers homed on OTHER dashboards stay off this dashboard's ledger.
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
      .addCase(fetchLayout.rejected, (state, action) => {
        if (
          action.meta.arg.dashboardId !== state.activeFetchDashboardId
          || action.meta.requestId !== state.activeFetchRequestId
        ) return;
        state.loading = false;
        // Fail-open for RENDERING only; saveArmed stays false so this client can never persist the empty layout it booted with over the server's real one (the wipe that hit 2026-07-20).
        state.initialized = true;
        // Revoke only this dashboard's save authority until a later successful fetch restores its baseline.
        delete state.unknownPersistedLayoutFieldsByDashboard[action.meta.arg.dashboardId];
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

export const selectFullscreenCardId = (state: { dashboardLayout: DashboardLayoutState }): string | null => {
  const s = state.dashboardLayout;
  const entry = Object.entries(s.tiledCards).find(([, zone]) => zone === 'fullscreen');
  if (!entry) return null;
  const id = entry[0];
  // Belt over the reducer hygiene: an entry whose card is gone (any removal path) must not hold the app in fullscreen.
  return tileOwnerExists(s, id) && !s.minimizedCards[id] ? id : null;
};

export default dashboardLayoutSlice.reducer;
