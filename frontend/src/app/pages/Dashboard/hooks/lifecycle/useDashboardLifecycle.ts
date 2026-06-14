import { useEffect, useRef, type MutableRefObject } from 'react';
import { report } from '@/shared/serviceClient';
import { store } from '@/shared/state/store';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchSessions,
  fetchHistory,
  setExpandedSessionIds,
  type AgentSession,
} from '@/shared/state/agentsSlice';
import {
  fetchLayout,
  reconcileSessions,
  addBrowserCard,
  resetLayout,
  removeViewCard,
  clearPendingFocusBrowserId,
  type ViewCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { fetchOutputs, type Output } from '@/shared/state/outputsSlice';
import { generateDashboardName } from '@/shared/state/dashboardsSlice';
import { dashboardWs } from '@/shared/ws/WebSocketManager';
import { initBrowserCommandHandler } from '@/shared/browserCommandHandler';
import { clearPendingBrowserUrl, clearPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { API_BASE } from '@/shared/config';
import type { CanvasActions } from '../interaction/useCanvasControls';

interface UseDashboardLifecycleArgs {
  isActive: boolean;
  dashboardId: string;
  layoutInitialized: boolean;
  sessions: Record<string, AgentSession>;
  expandedSessionIds: string[];
  persistedExpandedSessionIds: string[];
  viewCards: Record<string, ViewCardPosition>;
  outputs: Record<string, Output>;
  outputsLoaded: boolean;
  canvasActions: CanvasActions;
  handleHighlightCard: (cardId: string) => void;
  hasFittedRef: MutableRefObject<boolean>;
  restoredExpandedRef: MutableRefObject<boolean>;
}

export function useDashboardLifecycle({
  isActive,
  dashboardId,
  layoutInitialized,
  sessions,
  expandedSessionIds,
  persistedExpandedSessionIds,
  viewCards,
  outputs,
  outputsLoaded,
  canvasActions,
  handleHighlightCard,
  hasFittedRef,
  restoredExpandedRef,
}: UseDashboardLifecycleArgs) {
  const dispatch = useAppDispatch();
  const pendingBrowserUrl = useAppSelector((state) => state.tempState.pendingBrowserUrl);
  const pendingFocusAgentId = useAppSelector((state) => state.tempState.pendingFocusAgentId);
  const pendingFocusBrowserId = useAppSelector((state) => state.dashboardLayout.pendingFocusBrowserId);

  // Track dashboard engagement time
  useEffect(() => {
    if (!dashboardId) return;
    const startTime = Date.now();
    report('dashboard', 'opened', { dashboard_id: dashboardId });
    return () => {
      report('dashboard', 'closed', {
        dashboard_id: dashboardId,
        time_spent_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    };
  }, [dashboardId]);

  useEffect(() => {
    if (!dashboardId) return;
    hasFittedRef.current = false;
    restoredExpandedRef.current = false;
    dispatch(resetLayout());
    // CRITICAL path: these populate the cards the user expects to see
    // on first paint. Don't defer.
    dispatch(fetchSessions({ dashboardId }));
    dispatch(fetchLayout({ dashboardId }));
    const cleanupBrowserHandler = initBrowserCommandHandler();
    // Global broadcasts (spawned browser cards) skip the replay log, so a
    // socket gap loses them; a reconnect refetch is the only way they return.
    const unsubReconnect = dashboardWs.on('dashboard:reconnected', () => {
      dispatch(fetchSessions({ dashboardId }));
      dispatch(fetchLayout({ dashboardId, isReconnect: true }));
    });
    // DEFERRABLE: history list (for the search palette) and outputs
    // (for the apps panel) aren't on the first-paint path. Same for the
    // dashboard WS connection (it carries cross-session events; opens
    // ~100ms later costs nothing). Pushing these into the post-paint
    // window measurably improves LCP because the initial render
    // pipeline isn't competing with their thunks/network setup.
    const idleHandle = (typeof window !== 'undefined' && (window as any).requestIdleCallback)
      ? (window as any).requestIdleCallback(() => {
          dispatch(fetchHistory({ dashboardId }));
          dispatch(fetchOutputs());
          dashboardWs.connect();
        }, { timeout: 2000 })
      : window.setTimeout(() => {
          dispatch(fetchHistory({ dashboardId }));
          dispatch(fetchOutputs());
          dashboardWs.connect();
        }, 200);

    // Pre-warm Anthropic's prompt cache for sessions on this dashboard
    // ~250ms after mount (debounced; AbortController cancels on
    // dashboard switch). Fires a max_tokens=1 ping per session so the
    // user's first real message hits a warm cache instead of paying
    // cold-start TTFT. Cheap (~$0.0001/session) and non-blocking. Skips
    // for non-Anthropic sessions server-side.
    const warmAbort = new AbortController();
    const warmTimer = setTimeout(async () => {
      try {
        const sessionsState = store.getState().agents.sessions;
        const dashSessions = Object.values(sessionsState).filter(
          (s) => s.dashboard_id === dashboardId &&
                 s.status !== 'draft' &&
                 s.mode !== 'browser-agent' &&
                 s.mode !== 'sub-agent' &&
                 s.mode !== 'invoked-agent',
        );
        for (const s of dashSessions) {
          if (warmAbort.signal.aborted) break;
          // Fire-and-forget , the endpoint always 200s and the side
          // effect is invisible cache population.
          fetch(`${API_BASE}/agents/sessions/${s.id}/warm-cache`, {
            method: 'POST',
            signal: warmAbort.signal,
          }).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    }, 250);

    return () => {
      clearTimeout(warmTimer);
      warmAbort.abort();
      cleanupBrowserHandler();
      unsubReconnect();
      dashboardWs.disconnect();
      // Cancel any not-yet-fired idle work; the cleanup handler can't
      // run partially if the dashboard switches before idle fired.
      if (typeof window !== 'undefined') {
        const cancelIdle = (window as any).cancelIdleCallback;
        if (cancelIdle && typeof idleHandle === 'number') cancelIdle(idleHandle);
        else if (typeof idleHandle === 'number') clearTimeout(idleHandle);
      }
    };
  }, [dispatch, dashboardId]);

  useEffect(() => {
    if (!dashboardId) return;
    (window as any).__openswarm_last_dashboard_id = dashboardId;
  }, [dashboardId]);

  useEffect(() => {
    if (!pendingBrowserUrl || !layoutInitialized) return;
    dispatch(addBrowserCard({ url: pendingBrowserUrl, expandedSessionIds }));
    dispatch(clearPendingBrowserUrl());
  }, [pendingBrowserUrl, layoutInitialized, dispatch, expandedSessionIds]);

  useEffect(() => {
    if (!isActive) return;  // Don't auto-fit while dashboard is hidden
    if (!layoutInitialized || hasFittedRef.current) return;
    if (pendingFocusAgentId) return;
    hasFittedRef.current = true;
    const timer = setTimeout(() => canvasActions.fitToView(), 150);
    return () => clearTimeout(timer);
  }, [isActive, layoutInitialized, canvasActions, pendingFocusAgentId]);

  useEffect(() => {
    if (!isActive) return;  // Defer focus animation until dashboard is visible
    if (!pendingFocusAgentId || !layoutInitialized) return;
    const agentId = pendingFocusAgentId;
    dispatch(clearPendingFocusAgentId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.cards[agentId];
      if (card) {
        canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(agentId);
      }
    }, 350);
  }, [isActive, pendingFocusAgentId, layoutInitialized, dispatch, canvasActions, handleHighlightCard]);

  // Auto-focus a newly created browser card. The reducer that handles
  // addBrowserCard sets pendingFocusBrowserId to the new card's id; this
  // effect picks it up, pans/zooms the canvas to center on it, briefly
  // highlights it, then clears the signal. Mirrors the pendingFocusAgentId
  // pattern above so link clicks (intercepted in AppShell) get the same
  // auto-focus behavior as the "+ Browser" toolbar button.
  //
  // Uses zoom=0.8 (the same value handleCardClick uses for browser cards
  // at line ~344) instead of letting fitToCards auto-derive a zoom from
  // padding. Browser cards are large (1280x800), so the auto-derived zoom
  // would land around ~58% which feels too far back; 0.8 matches the
  // "click on a browser to focus" experience the user expects.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingFocusBrowserId || !layoutInitialized) return;
    const browserId = pendingFocusBrowserId;
    dispatch(clearPendingFocusBrowserId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.browserCards[browserId];
      if (card) {
        canvasActions.fitToCards(
          [{ x: card.x, y: card.y, width: card.width, height: card.height }],
          1.15,
          true,
          0.8,
        );
        handleHighlightCard(browserId);
      }
    }, 200);
  }, [isActive, pendingFocusBrowserId, layoutInitialized, dispatch, canvasActions, handleHighlightCard]);

  useEffect(() => {
    if (!layoutInitialized || restoredExpandedRef.current) return;
    restoredExpandedRef.current = true;
    dispatch(setExpandedSessionIds(persistedExpandedSessionIds));
  }, [layoutInitialized, persistedExpandedSessionIds, dispatch]);

  const prevSessionIdsRef = useRef<string>('');

  useEffect(() => {
    if (!layoutInitialized) return;
    const dashboardSessionIds = Object.values(sessions)
      .filter((s) => s.dashboard_id === dashboardId && s.mode !== 'browser-agent' && s.mode !== 'invoked-agent' && s.mode !== 'sub-agent')
      .map((s) => s.id);
    const liveIds = dashboardSessionIds.sort().join(',');
    if (liveIds === prevSessionIdsRef.current) return;
    prevSessionIdsRef.current = liveIds;
    dispatch(reconcileSessions({ sessionIds: dashboardSessionIds, expandedSessionIds }));
  }, [sessions, layoutInitialized, dispatch, dashboardId, expandedSessionIds]);

  // Prune orphan view cards whose underlying output was deleted (e.g. via
  // the Views page). Without this, the layout entry persists in the
  // minimap and contentBounds even though DashboardViewCard renders
  // nothing. Gated on outputsLoaded so we don't wipe valid cards during
  // the brief window between fetchLayout returning and outputs finishing.
  useEffect(() => {
    if (!layoutInitialized || !outputsLoaded) return;
    for (const outputId of Object.keys(viewCards)) {
      if (!outputs[outputId]) dispatch(removeViewCard(outputId));
    }
  }, [layoutInitialized, outputsLoaded, viewCards, outputs, dispatch]);

  const namedOnFirstMessageRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dashboardId || !layoutInitialized) return;
    if (namedOnFirstMessageRef.current === dashboardId) return;
    const dash = store.getState().dashboards.items[dashboardId];
    if (!dash) return;
    if (!dash.auto_named && dash.name !== 'Untitled Dashboard') return;
    const hasUserMessage = Object.values(sessions).some(
      (s) => s.dashboard_id === dashboardId && s.messages?.some((m) => m.role === 'user'),
    );
    if (!hasUserMessage) return;
    namedOnFirstMessageRef.current = dashboardId;
    dispatch(generateDashboardName(dashboardId));
  }, [sessions, dashboardId, layoutInitialized, dispatch]);
}
