import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import { setExpandedSessionIds } from '@/shared/state/agentsSlice';
import { GET_ALL_SESSIONS, GET_HISTORY } from '@/shared/backend-bridge/apps/agents';
import { GET_DASHBOARD } from '@/shared/backend-bridge/apps/dashboards';
import {
  resetLayout,
  reconcileSessions,
  addBrowserCard,
  EXPANDED_CARD_MIN_H,
} from '@/shared/state/dashboardLayoutSlice';
import { LIST_APPS } from '@/shared/backend-bridge/apps/app_builder';
import { dashboardWs } from '@/shared/ws/WebSocketManager';
import { initBrowserCommandHandler } from '@/shared/browserCommandHandler';
import { clearPendingBrowserUrl, clearPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import type { CanvasActions } from '../useCanvasControls';

interface InitDeps {
  dashboardId: string | undefined;
  layoutInitialized: boolean;
  expandedSessionIds: string[];
  persistedExpandedSessionIds: string[];
  sessions: Record<string, any>;
  cards: Record<string, any>;
  canvasActions: CanvasActions;
  handleHighlightCard: (cardId: string) => void;
  pendingBrowserUrl: string | null;
  pendingFocusAgentId: string | null;
  measuredHeightsRef: React.RefObject<Record<string, number>>;
}

export function useDashboardInit(deps: InitDeps) {
  const {
    dashboardId, layoutInitialized, expandedSessionIds,
    persistedExpandedSessionIds, sessions, cards, canvasActions,
    handleHighlightCard, pendingBrowserUrl, pendingFocusAgentId,
    measuredHeightsRef,
  } = deps;
  const dispatch = useAppDispatch();

  const hasFittedRef = useRef(false);
  const restoredExpandedRef = useRef(false);
  const prevSessionIdsRef = useRef<string>('');
  const prevExpandedRef = useRef<string[]>([]);

  useEffect(() => {
    if (!dashboardId) return;
    hasFittedRef.current = false;
    restoredExpandedRef.current = false;
    dispatch(resetLayout());
    dispatch(GET_ALL_SESSIONS(dashboardId));
    dispatch(GET_HISTORY({}));
    dispatch(GET_DASHBOARD(dashboardId));
    dispatch(LIST_APPS());
    dashboardWs.connect();
    const cleanupBrowserHandler = initBrowserCommandHandler();
    return () => { cleanupBrowserHandler(); dashboardWs.disconnect(); };
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
    if (!layoutInitialized || hasFittedRef.current) return;
    if (pendingFocusAgentId) return;
    hasFittedRef.current = true;
    const timer = setTimeout(() => canvasActions.fitToView(), 150);
    return () => clearTimeout(timer);
  }, [layoutInitialized, canvasActions, pendingFocusAgentId]);

  useEffect(() => {
    if (!pendingFocusAgentId || !layoutInitialized) return;
    const agentId = pendingFocusAgentId;
    dispatch(clearPendingFocusAgentId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.cards[agentId];
      if (card) {
        canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
        handleHighlightCard(agentId);
      }
    }, 350);
  }, [pendingFocusAgentId, layoutInitialized, dispatch, canvasActions, handleHighlightCard]);

  useEffect(() => {
    if (!layoutInitialized || restoredExpandedRef.current) return;
    restoredExpandedRef.current = true;
    dispatch(setExpandedSessionIds(persistedExpandedSessionIds));
  }, [layoutInitialized, persistedExpandedSessionIds, dispatch]);

  useEffect(() => {
    if (!layoutInitialized) return;
    const dashboardSessionIds = Object.values(sessions)
      .filter((s: any) => s.dashboard_id === dashboardId && s.mode !== 'browser-agent' && s.mode !== 'invoked-agent' && s.mode !== 'sub-agent')
      .map((s: any) => s.id);
    const liveIds = dashboardSessionIds.sort().join(',');
    if (liveIds === prevSessionIdsRef.current) return;
    prevSessionIdsRef.current = liveIds;
    dispatch(reconcileSessions({ sessionIds: dashboardSessionIds, expandedSessionIds }));
  }, [sessions, layoutInitialized, dispatch, dashboardId, expandedSessionIds]);

  useEffect(() => {
    if (!layoutInitialized) {
      prevExpandedRef.current = expandedSessionIds;
      return;
    }
    const prev = new Set(prevExpandedRef.current);
    const newlyExpanded = expandedSessionIds.filter((id) => !prev.has(id));
    prevExpandedRef.current = expandedSessionIds;
    if (newlyExpanded.length !== 1) return;
    const cardId = newlyExpanded[0];
    const card = cards[cardId];
    if (!card) return;
    setTimeout(() => {
      const height = Math.max(EXPANDED_CARD_MIN_H, (measuredHeightsRef.current ?? {})[cardId] || card.height);
      canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height }], 2.0, true);
    }, 200);
  }, [expandedSessionIds, layoutInitialized, cards, canvasActions, measuredHeightsRef]);
}
