import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { store } from '@/shared/state/store';
import { useAppDispatch } from '@/shared/hooks';
import {
  expandSession,
  launchAndSendFirstMessage,
  generateTitle,
  type AgentConfig,
} from '@/shared/state/agentsSlice';
import {
  placeCard,
  setGlowingAgentCard,
  setGlowingBrowserCards,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  type CardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { generateDashboardName } from '@/shared/state/dashboardsSlice';
import type { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import type { CanvasActions } from '../interaction/useCanvasControls';

type SpawnOrigin = { x: number; y: number; type?: 'branch' };

interface UseAgentSpawnArgs {
  cards: Record<string, CardPosition>;
  expandedSessionIds: string[];
  dashboardId: string;
  expandNewChats: boolean;
  canvasActions: CanvasActions;
  viewportRef: RefObject<HTMLDivElement | null>;
  toolbarRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  handleHighlightCard: (cardId: string) => void;
  setToolbarOpen: Dispatch<SetStateAction<boolean>>;
  setAutoFocusSessionId: Dispatch<SetStateAction<string | null>>;
  setPendingSelectSessionId: Dispatch<SetStateAction<string | null>>;
}

export function useAgentSpawn({
  cards,
  expandedSessionIds,
  dashboardId,
  expandNewChats,
  canvasActions,
  viewportRef,
  toolbarRef,
  canvasStateRef,
  spawnOriginsRef,
  handleHighlightCard,
  setToolbarOpen,
  setAutoFocusSessionId,
  setPendingSelectSessionId,
}: UseAgentSpawnArgs) {
  const dispatch = useAppDispatch();

  const handleBranchFromCard = useCallback(
    (sourceSessionId: string, newSessionId: string) => {
      const sourceCard = cards[sourceSessionId];
      if (!sourceCard) return;

      const targetX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      let targetY = sourceCard.y;

      const columnCards = Object.values(cards).filter(
        (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== newSessionId,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }

      spawnOriginsRef.current![newSessionId] = {
        x: sourceCard.x,
        y: sourceCard.y,
        type: 'branch' as const,
      };

      dispatch(placeCard({
        sessionId: newSessionId,
        x: targetX,
        y: targetY,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
        expandedSessionIds,
      }));

      if (expandedSessionIds.includes(sourceSessionId)) {
        dispatch(expandSession(newSessionId));
      }

      dispatch(setGlowingAgentCard({ sessionId: newSessionId, sourceId: sourceSessionId, label: 'Branch' }));
    },
    [cards, dispatch, expandedSessionIds],
  );

  const handleNewAgent = useCallback(() => {
    setToolbarOpen(true);
  }, []);

  const handleToolbarCancel = useCallback(() => {
    setToolbarOpen(false);
  }, []);

  const handleToolbarSend = useCallback(
    (
      prompt: string,
      mode: string,
      model: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: ContextPath[],
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
    ) => {
      setToolbarOpen(false);
      report('dashboard', 'agent_created', { mode, model, has_images: !!images?.length, has_context: !!contextPaths?.length, has_browser: !!selectedBrowserIds?.length });

      const draftId = `draft-${Date.now().toString(36)}`;

      const toolbarEl = toolbarRef.current;
      const vpEl = viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const toolbarCenterX = tr.left + tr.width / 2;
        const toolbarTopY = tr.top;
        const { panX, panY, zoom } = canvasStateRef.current!;
        spawnOriginsRef.current![draftId] = {
          x: (toolbarCenterX - vr.left - panX) / zoom,
          y: (toolbarTopY - vr.top - panY) / zoom,
        };
      }

      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };

      dispatch(
        launchAndSendFirstMessage({
          draftId,
          config,
          prompt,
          mode,
          model,
          images,
          contextPaths: contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })),
          forcedTools,
          attachedSkills,
          expand: expandNewChats,
        }),
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          if (selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));

            if (selectedBrowserIds.length === 1) {
              const bc = store.getState().dashboardLayout.browserCards[selectedBrowserIds[0]];
              if (bc) {
                // Use placeCard (collision-aware) instead of
                // setCardPosition (blind setter). The "left of the
                // browser" anchor is the IDEAL spot , but if it's
                // already taken by an existing chat (e.g. step 3's
                // YouTube agent that's still on canvas when step 5
                // creates a new chat for the same browser), placeCard
                // cascades to the nearest free cell instead of
                // stacking on top.
                dispatch(placeCard({
                  sessionId: realId,
                  x: bc.x - DEFAULT_CARD_W - GRID_GAP * 12,
                  y: bc.y,
                  width: DEFAULT_CARD_W,
                  height: DEFAULT_CARD_H,
                  expandedSessionIds,
                }));
              }
            }
          }
          spawnOriginsRef.current![realId] = spawnOriginsRef.current![draftId];
          delete spawnOriginsRef.current![draftId];

          if (expandNewChats) {
            setAutoFocusSessionId(realId);
            dispatch(expandSession(realId));
          } else {
            setPendingSelectSessionId(realId);
          }

          setTimeout(() => {
            const card = store.getState().dashboardLayout.cards[realId];
            if (card) {
              canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
              handleHighlightCard(realId);
            }
          }, 200);

          if (dashboardId) {
            const currentSessions = store.getState().agents.sessions;
            const agentCount = Object.values(currentSessions).filter(
              (s) => s.status !== 'draft' && s.dashboard_id === dashboardId,
            ).length;
            const NAME_GEN_TRIGGERS = [1, 3, 6];
            const currentDash = store.getState().dashboards.items[dashboardId];
            const canAutoName =
              currentDash &&
              (currentDash.auto_named || currentDash.name === 'Untitled Dashboard');

            if (NAME_GEN_TRIGGERS.includes(agentCount) && canAutoName) {
              dispatch(generateDashboardName(dashboardId));
            }
          }
        } else {
          delete spawnOriginsRef.current![draftId];
        }
      });
    },
    [viewportRef, canvasActions, dispatch, dashboardId, expandNewChats, handleHighlightCard],
  );

  return {
    handleBranchFromCard,
    handleNewAgent,
    handleToolbarCancel,
    handleToolbarSend,
  };
}
