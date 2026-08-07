import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { store } from '@/shared/state/store';
import { useAppSelector } from '@/shared/hooks';
import { updateDashboardThumbnail } from '@/shared/state/dashboardsSlice';
import { anyWebviewLoading } from '@/shared/browserRegistry';
import { isCanvasInteractionActive } from '@/shared/canvasInteractionState';
import { isAnyBrowserBusy } from '@/shared/browserCommandHandler';
import { captureDashboardThumbnail } from '../../geometry/captureDashboardThumbnail';

// Settle window after a card is added/removed before snapshotting, so the new card has a beat to render.
const DASHBOARD_CAPTURE_DELAY_MS = 1200;

// Sorted set of every card id on the canvas. Changes on add/remove (not on move), so we can tell whether the dashboard's contents differ from the last screenshot.
function dashboardSignature(s: {
  cards: Record<string, unknown>;
  viewCards: Record<string, unknown>;
  browserCards: Record<string, unknown>;
}): string {
  return [
    ...Object.keys(s.cards),
    ...Object.keys(s.viewCards),
    ...Object.keys(s.browserCards),
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
  // Screenshot the dashboard's contents for its card preview. Native Electron capturePage (no DOM mutation, no flash). We snapshot while the dashboard is visible whenever its card set changes and dispatch the update in-place, so the sidebar reorders as soon as the change settles rather than waiting for the user to navigate away.
  const currentSignature = useAppSelector((state) =>
    dashboardSignature(state.dashboardLayout),
  );
  const savedSignature = useAppSelector((state) =>
    dashboardId ? (state.dashboards.items[dashboardId]?.preview_signature ?? null) : null,
  );
  const savedSignatureRef = useRef<string | null>(savedSignature);
  savedSignatureRef.current = savedSignature;

  // Baseline we compare against; seeded from the persisted signature, advanced on each commit.
  const lastSavedSignatureRef = useRef<string | null>(savedSignature);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureRetriesRef = useRef(0);

  const captureNow = useCallback(() => {
    if (!dashboardId) return;
    const viewportEl = viewportRef.current;
    const contentEl = contentRef.current;
    if (!viewportEl || !contentEl) return;
    const layoutState = store.getState().dashboardLayout;
    const sig = dashboardSignature(layoutState);
    if (!sig) {
      // Emptied dashboard: clear the preview so its card falls back to the default icon.
      if (lastSavedSignatureRef.current !== '') {
        store.dispatch(updateDashboardThumbnail({ id: dashboardId, thumbnail: '', signature: '' }));
        lastSavedSignatureRef.current = '';
      }
      return;
    }
    // Capturing the dashboard composites live webview pixels; doing it while a browser webview is mid-navigation OR an agent is actively driving it (its GPU surface recycling) crashes the renderer (SharedImage 'non-existent mailbox' -> V8 ToLocalChecked). Wait for it to go quiet; after a few tries, skip this round and keep the old preview rather than risk the crash. Mid-gesture captures also land inside the user's interaction frames (ENG-156's presentation delay), so those wait too.
    if (anyWebviewLoading() || isAnyBrowserBusy() || isCanvasInteractionActive()) {
      if (captureRetriesRef.current < 6) {
        captureRetriesRef.current += 1;
        if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
        captureTimerRef.current = setTimeout(() => captureNow(), 800);
      }
      return;
    }
    captureRetriesRef.current = 0;
    const allCards = {
      cards: layoutState.cards,
      viewCards: layoutState.viewCards,
      browserCards: layoutState.browserCards,
    };
    const capturingId = dashboardId;
    // Idle-scheduled so the capturePage IPC + dataURL decode never ride the frames right after a click.
    requestIdleCallback(() => {
      captureDashboardThumbnail(viewportEl, contentEl, allCards)
        .then((thumbnail) => {
          if (!thumbnail) return;
          if (sig === lastSavedSignatureRef.current) return;
          store.dispatch(updateDashboardThumbnail({ id: capturingId, thumbnail, signature: sig }));
          lastSavedSignatureRef.current = sig;
        })
        .catch(() => {});
    }, { timeout: 3000 });
  }, [dashboardId, viewportRef, contentRef]);

  // While visible, (re)snapshot a beat after the card set changes. If it already matches the saved shot (or was reverted back to it), cancel any pending capture instead of committing stale pixels.
  useEffect(() => {
    if (!isActive || !dashboardId || !layoutInitialized) return;
    if (currentSignature === lastSavedSignatureRef.current) {
      if (captureTimerRef.current) {
        clearTimeout(captureTimerRef.current);
        captureTimerRef.current = null;
      }
      return;
    }
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, DASHBOARD_CAPTURE_DELAY_MS);
    return () => {
      if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    };
  }, [isActive, dashboardId, layoutInitialized, currentSignature, captureNow]);

  // Persistent component: dashboardId is a prop. Re-baseline the signature when switching dashboards.
  useEffect(() => {
    lastSavedSignatureRef.current = savedSignatureRef.current;
  }, [dashboardId]);

  return { captureNow };
}
