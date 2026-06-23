import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  saveLayout,
  type CardPosition,
  type ViewCardPosition,
  type BrowserCardPosition,
  type NotePosition,
  type WorkflowCardPosition,
  type WorkflowsHubPosition,
} from '@/shared/state/dashboardLayoutSlice';

interface UseLayoutSaveArgs {
  isActive: boolean;
  layoutInitialized: boolean;
  dashboardId: string;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  notes: Record<string, NotePosition>;
  expandedSessionIds: string[];
  captureNow: () => void;
}

// Debounced layout persistence. The buffered pendingSaveRef + the unmount
// flush live together here, and this hook tears down exactly when
// DashboardInner does, so the launchAndSendFirstMessage-vs-unmount race
// keeps the same cadence it had inline.
export function useLayoutSave({
  isActive,
  layoutInitialized,
  dashboardId,
  cards,
  viewCards,
  browserCards,
  workflowCards,
  workflowsHub,
  notes,
  expandedSessionIds,
  captureNow,
}: UseLayoutSaveArgs) {
  const dispatch = useAppDispatch();
  const skipInitialSave = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Parameters<typeof saveLayout>[0] | null>(null);

  useEffect(() => {
    if (!isActive) return;  // Don't persist layout while dashboard is hidden , save buffers in pendingSaveRef and flushes on resume
    if (!layoutInitialized || !dashboardId) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    const payload = { dashboardId, cards, viewCards, browserCards, workflowCards, workflowsHub, notes, expandedSessionIds };
    pendingSaveRef.current = payload;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      dispatch(saveLayout(payload));
      pendingSaveRef.current = null;
      saveTimerRef.current = null;
      captureNow();
    }, 500);
  }, [isActive, cards, viewCards, browserCards, workflowCards, workflowsHub, notes, expandedSessionIds, layoutInitialized, dashboardId, dispatch, captureNow]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (pendingSaveRef.current) {
        dispatch(saveLayout(pendingSaveRef.current));
        pendingSaveRef.current = null;
      }
    };
  }, [dispatch]);
}
