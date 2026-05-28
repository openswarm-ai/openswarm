import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { store } from '@/shared/state/store';
import { useAppSelector } from '@/shared/hooks';
import { updateDashboardThumbnail } from '@/shared/state/dashboardsSlice';
import { captureDashboardThumbnail } from '../../geometry/captureDashboardThumbnail';

// Settle window after a card is added/removed before snapshotting, so the new card has a beat to render.
const DASHBOARD_CAPTURE_DELAY_MS = 1200;

// Sorted set of every card id on the canvas. Changes on add/remove (not on move),
// so we can tell whether the dashboard's contents differ from the last screenshot.
function dashboardSignature(s: {
  cards: Record<string, unknown>;
  viewCards: Record<string, unknown>;
  browserCards: Record<string, unknown>;
  notes: Record<string, unknown>;
}): string {
  return [
    ...Object.keys(s.cards),
    ...Object.keys(s.viewCards),
    ...Object.keys(s.browserCards),
    ...Object.keys(s.notes),
  ].sort().join(',');
}

interface UseDashboardThumbnailArgs {
  isActive: boolean;
  dashboardId: string;
  layoutInitialized: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}

export function useDashboardThumbnail({
  isActive,
  dashboardId,
  layoutInitialized,
  viewportRef,
  contentRef,
}: UseDashboardThumbnailArgs) {
  // Screenshot the dashboard's contents for its card preview. Native Electron capturePage
  // (no DOM mutation, no flash). We snapshot while the dashboard is visible whenever its card
  // set changes, then commit on exit only if that set differs from the last saved shot, so
  // merely opening a dashboard never re-screenshots it (which would also reorder the sidebar).
  const currentSignature = useAppSelector((state) =>
    dashboardSignature(state.dashboardLayout),
  );
  const savedSignature = useAppSelector((state) =>
    dashboardId ? (state.dashboards.items[dashboardId]?.preview_signature ?? null) : null,
  );
  const savedSignatureRef = useRef<string | null>(savedSignature);
  savedSignatureRef.current = savedSignature;

  const pendingThumbnailRef = useRef<string | null>(null);
  const pendingSignatureRef = useRef<string | null>(null);
  // Baseline we compare against; seeded from the persisted signature, advanced on each commit.
  const lastSavedSignatureRef = useRef<string | null>(savedSignature);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const captureNow = useCallback(() => {
    const viewportEl = viewportRef.current;
    const contentEl = contentRef.current;
    if (!viewportEl || !contentEl) return;
    const layoutState = store.getState().dashboardLayout;
    const sig = dashboardSignature(layoutState);
    if (!sig) {
      // Emptied dashboard: queue a clear ('') so its card falls back to the default icon.
      pendingThumbnailRef.current = '';
      pendingSignatureRef.current = '';
      return;
    }
    const allCards = {
      cards: layoutState.cards,
      viewCards: layoutState.viewCards,
      browserCards: layoutState.browserCards,
    };
    captureDashboardThumbnail(viewportEl, contentEl, allCards)
      .then((thumbnail) => {
        if (thumbnail) {
          pendingThumbnailRef.current = thumbnail;
          pendingSignatureRef.current = sig;
        }
      })
      .catch(() => {});
  }, [viewportRef, contentRef]);

  // While visible, (re)snapshot a beat after the card set changes. If it already matches the
  // saved shot (or was reverted back to it), drop any pending capture instead of committing stale pixels.
  useEffect(() => {
    if (!isActive || !dashboardId || !layoutInitialized) return;
    if (currentSignature === lastSavedSignatureRef.current) {
      if (captureTimerRef.current) {
        clearTimeout(captureTimerRef.current);
        captureTimerRef.current = null;
      }
      pendingThumbnailRef.current = null;
      pendingSignatureRef.current = null;
      return;
    }
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, DASHBOARD_CAPTURE_DELAY_MS);
    return () => {
      if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    };
  }, [isActive, dashboardId, layoutInitialized, currentSignature, captureNow]);

  const commitThumbnail = useCallback((id: string) => {
    if (!id) return;
    const thumbnail = pendingThumbnailRef.current;
    if (thumbnail === null) return; // nothing captured this session
    const sig = pendingSignatureRef.current ?? '';
    if (sig === lastSavedSignatureRef.current) return; // card set unchanged since last shot
    store.dispatch(updateDashboardThumbnail({ id, thumbnail, signature: sig }));
    lastSavedSignatureRef.current = sig;
    pendingThumbnailRef.current = null;
    pendingSignatureRef.current = null;
  }, []);

  // Persistent component: dashboardId is a prop. On switch, the cleanup commits the dashboard
  // we're leaving; the setup re-baselines to the one we're entering. Cleanup also fires on unmount.
  useEffect(() => {
    lastSavedSignatureRef.current = savedSignatureRef.current;
    pendingThumbnailRef.current = null;
    pendingSignatureRef.current = null;
    const exitingId = dashboardId;
    return () => {
      commitThumbnail(exitingId);
    };
  }, [dashboardId, commitThumbnail]);

  // Navigating to /apps etc. keeps the dashboard mounted but flips it inactive; that's still an exit.
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevIsActiveRef.current && !isActive) commitThumbnail(dashboardId);
    prevIsActiveRef.current = isActive;
  }, [isActive, dashboardId, commitThumbnail]);

  return { captureNow };
}
