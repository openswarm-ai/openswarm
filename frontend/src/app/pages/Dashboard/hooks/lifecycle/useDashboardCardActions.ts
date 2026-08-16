import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { store } from '@/shared/state/store';
import { useAppDispatch } from '@/shared/hooks';
import { expandSession, resumeSession } from '@/shared/state/agentsSlice';
import {
  tidyLayout,
  addViewCard,
  addBrowserCard,
  DEFAULT_VIEW_CARD_W,
  DEFAULT_VIEW_CARD_H,
  DEFAULT_BROWSER_CARD_W,
  DEFAULT_BROWSER_CARD_H,
  EXPANDED_HEADER_H,
  renderedAgentCardHeight,
} from '@/shared/state/dashboardLayoutSlice';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';
import type { CanvasActions } from '../interaction/useCanvasControls';
import { useSpawnPlacement } from './useSpawnPlacement';

// Title bubble + cost line, the strip an expanded card floats above itself.

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseDashboardCardActionsArgs {
  expandedSessionIds: string[];
  browserHomepage: string;
  selection: Selection;
  canvasActions: CanvasActions;
  getCardRect: (id: string, type: CardType) => { x: number; y: number; width: number; height: number } | undefined;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  handleHighlightCard: (cardId: string) => void;
  setAutoFocusSessionId: Dispatch<SetStateAction<string | null>>;
}

export function useDashboardCardActions({
  expandedSessionIds,
  browserHomepage,
  selection,
  canvasActions,
  getCardRect,
  viewportRef,
  canvasStateRef,
  handleHighlightCard,
  setAutoFocusSessionId,
}: UseDashboardCardActionsArgs) {
  const dispatch = useAppDispatch();
  const getSpawnPlacement = useSpawnPlacement({ selection, viewportRef, canvasStateRef, expandedSessionIds });

  const handleAddView = useCallback((outputId: string, opts?: { newInstance?: boolean }) => {
    const pos = getSpawnPlacement(DEFAULT_VIEW_CARD_W, DEFAULT_VIEW_CARD_H);
    dispatch(addViewCard({ outputId, expandedSessionIds, x: pos.x, y: pos.y, newInstance: opts?.newInstance }));
    setTimeout(() => {
      // Focus whichever card the dispatch produced: with newInstance that's the highest-numbered instance of this output, else the primary.
      const viewCards = store.getState().dashboardLayout.viewCards;
      let focusKey = outputId;
      if (opts?.newInstance) {
        for (const [key, vc] of Object.entries(viewCards)) {
          if (vc.output_id === outputId && (vc.instance ?? 1) >= (viewCards[focusKey]?.instance ?? 1)) focusKey = key;
        }
      }
      const card = viewCards[focusKey];
      if (card) {
        canvasActions.revealCards([{ x: card.x, y: card.y, width: card.width, height: card.height }]);
        handleHighlightCard(focusKey);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, getSpawnPlacement, canvasActions, handleHighlightCard]);

  const handleAddBrowser = useCallback(() => {
    report('dashboard', 'browser_added');
    // Camera focus + highlight are handled by the pendingFocusBrowserId effect (useDashboardLifecycle), which fires for browsers from every path (toolbar, link clicks). Doing it here too would double-fit and fight that effect's zoom.
    const pos = getSpawnPlacement(DEFAULT_BROWSER_CARD_W, DEFAULT_BROWSER_CARD_H);
    dispatch(addBrowserCard({ url: browserHomepage, expandedSessionIds, x: pos.x, y: pos.y }));
  }, [dispatch, browserHomepage, expandedSessionIds, getSpawnPlacement]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(resumeSession({ sessionId })).then((action) => {
      if (resumeSession.fulfilled.match(action)) {
        dispatch(expandSession(sessionId));
        setAutoFocusSessionId(sessionId);
        setTimeout(() => {
          const rect = getCardRect(sessionId, 'agent');
          if (rect) {
            canvasActions.revealCards([rect]);
            handleHighlightCard(sessionId);
          }
        }, 200);
      }
    });
  }, [dispatch, canvasActions, handleHighlightCard, setAutoFocusSessionId, getCardRect]);

  // Context-aware fit: if a card is selected, zoom to it; otherwise fit all
  const handleFitToView = useCallback(() => {
    report('dashboard', 'fit_to_view', { has_selection: selection.selectedIds.size > 0 });
    if (selection.selectedIds.size === 1) {
      const [[id, type]] = selection.selectedIds;
      const rect = getCardRect(id, type);
      if (rect) {
        canvasActions.fitToCards([rect], 1.15, true);
        return;
      }
    }
    canvasActions.fitToView();
  }, [selection.selectedIds, getCardRect, canvasActions]);

  const handleTidy = useCallback(() => {
    report('dashboard', 'tidy_layout');
    const currentExpanded = store.getState().agents.expandedSessionIds;
    dispatch(tidyLayout({ expandedSessionIds: currentExpanded }));

    const expandedSet = new Set(currentExpanded);
    const {
      cards: tidied, viewCards: tidiedViews, browserCards: tidiedBrowsers,
      workflowCards: tidiedWorkflows, workflowsHub: tidiedHub,
      workflowsMonitorCard: tidiedMonitor, settingsCard: tidiedSettings,
    } = store.getState().dashboardLayout;
    const allRects = [
      ...Object.values(tidied).map((c) => {
        // An expanded card wears its title bubble ABOVE its rect, so the camera has to be told about that strip or Tidy frames the card and beheads it.
        const isExpanded = expandedSet.has(c.session_id);
        const height = renderedAgentCardHeight(c.height, isExpanded);
        return isExpanded
          ? { x: c.x, y: c.y - EXPANDED_HEADER_H, width: c.width, height: height + EXPANDED_HEADER_H }
          : { x: c.x, y: c.y, width: c.width, height };
      }),
      ...Object.values(tidiedViews).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedBrowsers).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedWorkflows).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      // The hub, the monitor and Settings get tidied into the grid too, so the camera has to know about them or it frames a stale box.
      ...[tidiedHub, tidiedMonitor, tidiedSettings]
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
    ];
    canvasActions.fitTidy(allRects);
  }, [dispatch, canvasActions]);

  return {
    handleAddView,
    handleAddBrowser,
    handleHistoryResume,
    handleFitToView,
    handleTidy,
  };
}
