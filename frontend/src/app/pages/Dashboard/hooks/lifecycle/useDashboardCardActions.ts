import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { store } from '@/shared/state/store';
import { useAppDispatch } from '@/shared/hooks';
import { expandSession, resumeSession } from '@/shared/state/agentsSlice';
import {
  tidyLayout,
  addViewCard,
  addBrowserCard,
  addNote,
  clearPendingFocusNoteId,
  EXPANDED_CARD_MIN_H,
} from '@/shared/state/dashboardLayoutSlice';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';
import type { CanvasActions } from '../interaction/useCanvasControls';

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseDashboardCardActionsArgs {
  expandedSessionIds: string[];
  browserHomepage: string;
  pendingFocusNoteId: string | null;
  selection: Selection;
  canvasActions: CanvasActions;
  getCardRect: (id: string, type: CardType) => { x: number; y: number; width: number; height: number } | undefined;
  handleHighlightCard: (cardId: string) => void;
  setAutoFocusSessionId: Dispatch<SetStateAction<string | null>>;
}

export function useDashboardCardActions({
  expandedSessionIds,
  browserHomepage,
  pendingFocusNoteId,
  selection,
  canvasActions,
  getCardRect,
  handleHighlightCard,
  setAutoFocusSessionId,
}: UseDashboardCardActionsArgs) {
  const dispatch = useAppDispatch();

  const handleAddView = useCallback((outputId: string) => {
    dispatch(addViewCard({ outputId, expandedSessionIds }));
    setTimeout(() => {
      const card = store.getState().dashboardLayout.viewCards[outputId];
      if (card) {
        canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(outputId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvasActions, handleHighlightCard]);

  const handleAddBrowser = useCallback(() => {
    report('dashboard', 'browser_added');
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.browserCards));
    dispatch(addBrowserCard({ url: browserHomepage, expandedSessionIds }));
    setTimeout(() => {
      const allBrowserCards = store.getState().dashboardLayout.browserCards;
      const newId = Object.keys(allBrowserCards).find((id) => !prevIds.has(id));
      if (newId) {
        const card = allBrowserCards[newId];
        canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, browserHomepage, expandedSessionIds, canvasActions, handleHighlightCard]);

  const handleAddNote = useCallback(() => {
    report('dashboard', 'note_added');
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.notes));
    dispatch(addNote({ expandedSessionIds }));
    setTimeout(() => {
      const allNotes = store.getState().dashboardLayout.notes;
      const newId = Object.keys(allNotes).find((id) => !prevIds.has(id));
      if (newId) {
        const note = allNotes[newId];
        canvasActions.fitToCards([{ x: note.x, y: note.y, width: note.width, height: note.height }], 1.15, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvasActions, handleHighlightCard]);

  // Auto-clear pendingFocusNoteId after the note has had a chance to mount + autofocus.
  useEffect(() => {
    if (!pendingFocusNoteId) return;
    const t = setTimeout(() => dispatch(clearPendingFocusNoteId()), 800);
    return () => clearTimeout(t);
  }, [pendingFocusNoteId, dispatch]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(resumeSession({ sessionId })).then((action) => {
      if (resumeSession.fulfilled.match(action)) {
        dispatch(expandSession(sessionId));
        setAutoFocusSessionId(sessionId);
        setTimeout(() => {
          const card = store.getState().dashboardLayout.cards[sessionId];
          if (card) {
            canvasActions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
            handleHighlightCard(sessionId);
          }
        }, 200);
      }
    });
  }, [dispatch, canvasActions, handleHighlightCard, setAutoFocusSessionId]);

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
    } = store.getState().dashboardLayout;
    const allRects = [
      ...Object.values(tidied).map((c) => ({
        x: c.x, y: c.y, width: c.width,
        height: expandedSet.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height,
      })),
      ...Object.values(tidiedViews).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedBrowsers).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedWorkflows).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...(tidiedHub ? [{ x: tidiedHub.x, y: tidiedHub.y, width: tidiedHub.width, height: tidiedHub.height }] : []),
    ];
    canvasActions.fitToCards(allRects);
  }, [dispatch, canvasActions]);

  return {
    handleAddView,
    handleAddBrowser,
    handleAddNote,
    handleHistoryResume,
    handleFitToView,
    handleTidy,
  };
}
