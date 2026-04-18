import { useEffect, useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import { store } from '@/shared/state/store';
import { UPDATE_DASHBOARD } from '@/shared/backend-bridge/apps/dashboards';
import { captureDashboardThumbnail } from '../captureDashboardThumbnail';

export function useDashboardThumbnail(
  viewportRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
  dashboardId: string | undefined,
  layoutInitialized: boolean,
) {
  const pendingThumbnailRef = useRef<string | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const captureNow = useCallback(() => {
    const viewportEl = viewportRef.current;
    const contentEl = contentRef.current;
    if (!viewportEl || !contentEl) return;
    const layoutState = store.getState().dashboardLayout;
    const allCards = {
      cards: layoutState.cards,
      viewCards: layoutState.viewCards,
      browserCards: layoutState.browserCards,
    };
    const hasCards = Object.keys(allCards.cards).length > 0
      || Object.keys(allCards.viewCards).length > 0
      || Object.keys(allCards.browserCards).length > 0;
    if (!hasCards) return;
    captureDashboardThumbnail(viewportEl, contentEl, allCards)
      .then((thumbnail) => { if (thumbnail) pendingThumbnailRef.current = thumbnail; })
      .catch(() => {});
  }, [viewportRef, contentRef]);

  useEffect(() => {
    if (!dashboardId || !layoutInitialized) return;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, 2000);
    return () => { if (captureTimerRef.current) clearTimeout(captureTimerRef.current); };
  }, [dashboardId, layoutInitialized, captureNow]);

  useEffect(() => {
    if (!dashboardId) return;
    const exitingId = dashboardId;
    return () => {
      const thumbnail = pendingThumbnailRef.current;
      if (thumbnail) {
        store.dispatch(UPDATE_DASHBOARD({ dashboardId: exitingId, thumbnail }));
        pendingThumbnailRef.current = null;
      }
    };
  }, [dashboardId]);

  return { captureNow };
}
