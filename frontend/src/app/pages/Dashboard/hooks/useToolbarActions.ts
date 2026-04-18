import { useCallback } from 'react';
import type { RefObject, MutableRefObject } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import type { AgentSession } from '@/shared/state/agentsTypes';
import { RESUME_SESSION, META_LAUNCH_AND_SEND } from '@/shared/backend-bridge/apps/agents';
import { expandSession } from '@/shared/state/agentsSlice';
import type { AgentConfig } from '@/shared/state/agentsSlice';
import {
  addViewCard,
  addBrowserCard,
  tidyLayout,
  placeCard,
  setCardPosition,
  setGlowingAgentCard,
  setGlowingBrowserCards,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition
} from '@/shared/state/dashboardLayoutSlice';
import { GENERATE_DASHBOARD_NAME } from '@/shared/backend-bridge/apps/dashboards';
import type { ContextPath } from '@/shared/state/agentsTypes';
import { type CanvasActions } from '@/app/pages/Dashboard/_shared/types';

interface ToolbarDeps {
  cards: Record<string, CardPosition>;
  expandedSessionIds: string[];
  viewportRef: RefObject<HTMLDivElement>;
  canvasActions: CanvasActions;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  toolbarRef: RefObject<HTMLDivElement>;
  spawnOriginsRef: MutableRefObject<Record<string, { x: number; y: number; type?: 'branch' }>>;
  dashboardId: string | undefined;
  expandNewChats: boolean;
  handleHighlightCard: (cardId: string) => void;
  browserHomepage: string;
  setAutoFocusSessionId: (v: string | null) => void;
  setPendingSelectSessionId: (v: string | null) => void;
  setToolbarOpen: (v: boolean) => void;
}

export function useToolbarActions(deps: ToolbarDeps) {
  const {
    cards, expandedSessionIds, viewportRef, canvasActions,
    canvasStateRef, toolbarRef, spawnOriginsRef, dashboardId, expandNewChats,
    handleHighlightCard, browserHomepage,
    setAutoFocusSessionId, setPendingSelectSessionId, setToolbarOpen,
  } = deps;
  const dispatch = useAppDispatch();

  const handleBranchFromCard = useCallback(
    (sourceSessionId: string, newSessionId: string) => {
      const sourceCard = cards[sourceSessionId];
      if (!sourceCard) return;
      const targetX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      let targetY = sourceCard.y;
      const columnCards = Object.values(cards).filter(
        (c: CardPosition) => Math.abs(c.x - targetX) < 50 && c.session_id !== newSessionId,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }
      spawnOriginsRef.current[newSessionId] = { x: sourceCard.x, y: sourceCard.y, type: 'branch' as const };
      dispatch(placeCard({ sessionId: newSessionId, x: targetX, y: targetY, width: DEFAULT_CARD_W, height: DEFAULT_CARD_H }));
      if (expandedSessionIds.includes(sourceSessionId)) dispatch(expandSession(newSessionId));
      dispatch(setGlowingAgentCard({ sessionId: newSessionId, sourceId: sourceSessionId, label: 'Branch' }));
    },
    [cards, dispatch, expandedSessionIds, spawnOriginsRef],
  );

  const handleNewAgent = useCallback(() => setToolbarOpen(true), [setToolbarOpen]);
  const handleToolbarCancel = useCallback(() => setToolbarOpen(false), [setToolbarOpen]);

  const handleToolbarSend = useCallback(
    (
      prompt: string, mode: string, model: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: ContextPath[], forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
    ) => {
      setToolbarOpen(false);
      const draftId = `draft-${Date.now().toString(36)}`;
      const toolbarEl = toolbarRef.current;
      const vpEl = viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const toolbarCenterX = tr.left + tr.width / 2;
        const toolbarTopY = tr.top;
        const { panX, panY, zoom } = canvasStateRef.current ?? { panX: 0, panY: 0, zoom: 1 };
        spawnOriginsRef.current[draftId] = {
          x: (toolbarCenterX - vr.left - panX) / zoom,
          y: (toolbarTopY - vr.top - panY) / zoom,
        };
      }
      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };
      const origin = spawnOriginsRef.current[draftId] ?? { x: 0, y: 0 };
      dispatch(placeCard({ sessionId: draftId, x: origin.x, y: origin.y, width: DEFAULT_CARD_W, height: DEFAULT_CARD_H }));
      dispatch(
        META_LAUNCH_AND_SEND({
          draftId, config, prompt, mode, model, images,
          contextPaths: contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })),
          forcedTools, attachedSkills, expand: expandNewChats,
        }),
      ).then((action) => {
        if (META_LAUNCH_AND_SEND.fulfilled.match(action)) {
          const realId = action.payload.session.session_id;
          // TODO: Implement title generation
          // dispatch(generateTitle({ sessionId: realId, prompt }));
          if (selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));
            if (selectedBrowserIds.length === 1) {
              const bc = store.getState().dashboardLayout.browserCards[selectedBrowserIds[0]];
              if (bc) {
                dispatch(setCardPosition({
                  sessionId: realId,
                  x: bc.x - DEFAULT_CARD_W - GRID_GAP * 12,
                  y: bc.y,
                }));
              }
            }
          }
          spawnOriginsRef.current[realId] = spawnOriginsRef.current[draftId];
          delete spawnOriginsRef.current[draftId];
          if (expandNewChats) setAutoFocusSessionId(realId);
          else setPendingSelectSessionId(realId);
          setTimeout(() => {
            const card = store.getState().dashboardLayout.cards[realId];
            if (card) {
              const isExp = store.getState().agents.expandedSessionIds.includes(realId);
              const height = isExp ? Math.max(EXPANDED_CARD_MIN_H, card.height) : card.height;
              canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height }], 1.0, true);
              handleHighlightCard(realId);
            }
          }, 200);
          if (dashboardId) {
            const currentSessions = store.getState().agents.sessions;
            const agentCount = Object.values(currentSessions).filter(
              (s: AgentSession) => s.status !== 'draft' && s.dashboard_id === dashboardId,
            ).length;
            const NAME_GEN_TRIGGERS = [1, 3, 6];
            const currentDash = store.getState().dashboards.items[dashboardId];
            const canAutoName =
              currentDash &&
              (currentDash.auto_named || currentDash.name === 'Untitled Dashboard');
            if (NAME_GEN_TRIGGERS.includes(agentCount) && canAutoName) {
              dispatch(GENERATE_DASHBOARD_NAME(dashboardId));
            }
          }
        } else {
          delete spawnOriginsRef.current[draftId];
        }
      });
    },
    [viewportRef, canvasActions, canvasStateRef, toolbarRef, spawnOriginsRef,
      dispatch, dashboardId, expandNewChats, handleHighlightCard,
      setAutoFocusSessionId, setPendingSelectSessionId, setToolbarOpen],
  );

  const handleAddView = useCallback((outputId: string) => {
    dispatch(addViewCard({ outputId, expandedSessionIds }));
    setTimeout(() => {
      const card = store.getState().dashboardLayout.viewCards[outputId];
      if (card) {
        canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
        handleHighlightCard(outputId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvasActions, handleHighlightCard]);

  const handleAddBrowser = useCallback(() => {
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.browserCards));
    dispatch(addBrowserCard({ url: browserHomepage, expandedSessionIds }));
    setTimeout(() => {
      const allBrowserCards = store.getState().dashboardLayout.browserCards;
      const newId = Object.keys(allBrowserCards).find((id) => !prevIds.has(id));
      if (newId) {
        const card = allBrowserCards[newId];
        canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, browserHomepage, expandedSessionIds, canvasActions, handleHighlightCard]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(RESUME_SESSION(sessionId)).then((action) => {
      if (RESUME_SESSION.fulfilled.match(action)) {
        dispatch(expandSession(sessionId));
        setAutoFocusSessionId(sessionId);
        setTimeout(() => {
          const card = store.getState().dashboardLayout.cards[sessionId];
          if (card) {
            canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
            handleHighlightCard(sessionId);
          }
        }, 200);
      }
    });
  }, [dispatch, canvasActions, handleHighlightCard, setAutoFocusSessionId]);

  const handleTidy = useCallback(() => {
    const currentExpanded = store.getState().agents.expandedSessionIds;
    dispatch(tidyLayout({ expandedSessionIds: currentExpanded }));
    const expandedSet = new Set(currentExpanded);
    const { cards: tidied, viewCards: tidiedViews, browserCards: tidiedBrowsers } = store.getState().dashboardLayout;
    const allRects = [
      ...Object.values(tidied).map((c: CardPosition) => ({
        x: c.x, y: c.y, width: c.width,
        height: expandedSet.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height,
      })),
      ...Object.values(tidiedViews).map((c: ViewCardPosition) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedBrowsers).map((c: BrowserCardPosition) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
    ];
    canvasActions.fitToCards(allRects);
  }, [dispatch, canvasActions]);

  return {
    handleBranchFromCard,
    handleNewAgent,
    handleToolbarCancel,
    handleToolbarSend,
    handleAddView,
    handleAddBrowser,
    handleHistoryResume,
    handleTidy,
  };
}
