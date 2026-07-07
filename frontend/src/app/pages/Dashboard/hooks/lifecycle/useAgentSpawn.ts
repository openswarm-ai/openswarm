import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { store } from '@/shared/state/store';
import { useAppDispatch } from '@/shared/hooks';
import {
  createDraftSession,
  removeDraftSession,
  expandSession,
  launchAndSendFirstMessage,
  generateTitle,
  type AgentConfig,
} from '@/shared/state/agentsSlice';
import {
  placeCard,
  removeCard,
  setGlowingAgentCard,
  setGlowingBrowserCards,
  clearGlowingBrowserCards,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  type CardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { generateDashboardName } from '@/shared/state/dashboardsSlice';
import type { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import type { CanvasActions } from '../interaction/useCanvasControls';
import type { useDashboardSelection } from '../state/useDashboardSelection';
import { useSpawnPlacement } from './useSpawnPlacement';

type SpawnOrigin = { x: number; y: number; type?: 'branch' };
type Selection = ReturnType<typeof useDashboardSelection>;

interface UseAgentSpawnArgs {
  cards: Record<string, CardPosition>;
  expandedSessionIds: string[];
  dashboardId: string;
  expandNewChats: boolean;
  selection: Selection;
  canvasActions: CanvasActions;
  viewportRef: RefObject<HTMLDivElement | null>;
  toolbarRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  spawnOriginsRef: RefObject<Record<string, SpawnOrigin>>;
  handleHighlightCard: (cardId: string) => void;
  setToolbarOpen: Dispatch<SetStateAction<boolean>>;
  setAutoFocusSessionId: Dispatch<SetStateAction<string | null>>;
  setPendingSelectSessionId: Dispatch<SetStateAction<string | null>>;
  /** First run only: clicking New Agent spawns the welcome chat instead of the composer. */
  welcomeEligible?: boolean;
  onWelcomeNewAgent?: () => void;
}

export function useAgentSpawn({
  cards,
  expandedSessionIds,
  dashboardId,
  expandNewChats,
  selection,
  canvasActions,
  viewportRef,
  toolbarRef,
  canvasStateRef,
  spawnOriginsRef,
  handleHighlightCard,
  setToolbarOpen,
  setAutoFocusSessionId,
  setPendingSelectSessionId,
  welcomeEligible,
  onWelcomeNewAgent,
}: UseAgentSpawnArgs) {
  const dispatch = useAppDispatch();
  const getSpawnPlacement = useSpawnPlacement({ selection, viewportRef, canvasStateRef, expandedSessionIds });

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
    // First run: spawn the welcome chat (cursor-clicked or hand-clicked) instead of the composer.
    if (welcomeEligible && onWelcomeNewAgent) {
      onWelcomeNewAgent();
      return;
    }
    setToolbarOpen(true);
  }, [welcomeEligible, onWelcomeNewAgent, setToolbarOpen]);

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
      selectedAppIds?: string[],
    ) => {
      setToolbarOpen(false);
      report('dashboard', 'agent_created', { mode, model, has_images: !!images?.length, has_context: !!contextPaths?.length, has_browser: !!selectedBrowserIds?.length });

      // Toolbar position in canvas coords drives the spawn-from-toolbar grow animation.
      let origin: SpawnOrigin | null = null;
      // Where the chat lands: beside the selected card, else in front of the viewport. Feeds the optimistic placement below, replacing the legacy toolbar-position anchor. Center on the height it will RENDER at (expanded chats are tall) so it lands vertically centered, not high-biased.
      const spawnPos = getSpawnPlacement(DEFAULT_CARD_W, expandNewChats ? EXPANDED_CARD_MIN_H : DEFAULT_CARD_H);
      const toolbarEl = toolbarRef.current;
      const vpEl = viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const { panX, panY, zoom } = canvasStateRef.current!;
        origin = {
          x: (tr.left + tr.width / 2 - vr.left - panX) / zoom,
          y: (tr.top - vr.top - panY) / zoom,
        };
      }

      // Single selected browser: the chat's ideal home is just left of that browser card.
      const browserAnchor =
        selectedBrowserIds?.length === 1
          ? store.getState().dashboardLayout.browserCards[selectedBrowserIds[0]]
          : undefined;

      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };
      // Editing an existing app: bind the launch to it so the backend edits in place instead of seeding a duplicate empty app (App Builder mode only).
      if (selectedAppIds?.length) config.selected_app_output_ids = selectedAppIds;

      // Optimistic spawn: materialize, expand, and focus the card NOW so none of it waits on the three launch round-trips. Without this the card only appears (collapsed, unfocused) when the WS 'running' event lands mid-launch, then expand+focus jump in late on fulfilled. The draft id is rekeyed in place to the server id on fulfilled, so no visual hop.
      const draftId = dispatch(createDraftSession({ mode, model, dashboardId, setActive: false })).payload.draftId;
      if (origin) spawnOriginsRef.current![draftId] = origin;

      const cardHeight = expandNewChats ? EXPANDED_CARD_MIN_H : DEFAULT_CARD_H;
      const anchorX = browserAnchor ? browserAnchor.x - DEFAULT_CARD_W - GRID_GAP * 12 : spawnPos.x;
      const anchorY = browserAnchor ? browserAnchor.y : spawnPos.y;
      // exact pins the resolved spawn point for the viewport-center / beside-card cases (dead-center, overlap allowed); the single-browser dock omits it so placeCard's collision-dodge cascades the chat off an occupied slot.
      dispatch(placeCard({ sessionId: draftId, x: anchorX, y: anchorY, width: DEFAULT_CARD_W, height: cardHeight, expandedSessionIds, exact: !browserAnchor }));
      if (expandNewChats) {
        dispatch(expandSession(draftId));
        setAutoFocusSessionId(draftId);
      } else {
        setPendingSelectSessionId(draftId);
      }
      // Tether the chat to the browser(s) it'll drive NOW so the arrow doesn't pop in after the launch round-trips. Keyed on the draft id; the fulfilled rekey carries it to the real session id in place.
      if (selectedBrowserIds?.length) {
        dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: draftId, label: 'Use Browser' }));
      }
      const placed = store.getState().dashboardLayout.cards[draftId];
      if (placed) {
        // Frame the chat plus any browser it's attached to, so the tether connection is visible from the first frame.
        const rects = [{ x: placed.x, y: placed.y, width: placed.width, height: cardHeight }];
        if (selectedBrowserIds?.length) {
          const bcards = store.getState().dashboardLayout.browserCards;
          for (const bid of selectedBrowserIds) {
            const bc = bcards[bid];
            if (bc) rects.push({ x: bc.x, y: bc.y, width: bc.width, height: bc.height });
          }
        }
        canvasActions.fitToCards(rects, 1.15, true, undefined, true);
        handleHighlightCard(draftId);
      }

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
          selectedBrowserIds,
          selectedAppIds,
          expand: expandNewChats,
        }),
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          // Re-point focus/selection at the rekeyed real card; the draft id is gone after the in-place swap. The browser tether rekeys with the card in the dashboardLayout extraReducer. Placement + centered fit already happened optimistically at spawn (spawnPos / browserAnchor), so there's nothing to re-place here.
          if (expandNewChats) setAutoFocusSessionId(realId);
          else setPendingSelectSessionId(realId);

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
          // Launch failed: tear down the optimistic draft (card + tether) so nothing orphaned lingers.
          dispatch(removeCard(draftId));
          dispatch(removeDraftSession(draftId));
          if (selectedBrowserIds?.length) dispatch(clearGlowingBrowserCards(draftId));
          delete spawnOriginsRef.current![draftId];
        }
      });
    },
    [viewportRef, canvasActions, dispatch, dashboardId, expandNewChats, expandedSessionIds, getSpawnPlacement, handleHighlightCard, setToolbarOpen, setAutoFocusSessionId, setPendingSelectSessionId, toolbarRef, canvasStateRef, spawnOriginsRef],
  );

  return {
    handleBranchFromCard,
    handleNewAgent,
    handleToolbarCancel,
    handleToolbarSend,
  };
}
