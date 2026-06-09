import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import {
  suspendBrowserCard,
  resumeBrowserCard,
  type BrowserCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { getWebview } from '@/shared/browserRegistry';
import { getActivity } from '@/shared/browserCommandHandler';

const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

const SETTLE_MS = 800;
// Hysteresis: suspend only well past the edge, resume just past it, so a card
// sitting on the boundary never flaps between webview and snapshot.
const SUSPEND_MARGIN_PX = 320;
const RESUME_MARGIN_PX = 96;
const SNAPSHOT_MAX_W = 1024;
// Below this on-screen width a live page is indistinguishable from its placeholder,
// so booted-parked cards on a zoomed-out canvas stay parked until zoomed into.
const RESUME_MIN_CARD_PX = 220;
// Hard ceiling on simultaneous live webviews; past it the farthest-from-center
// non-agent card gets parked, so heavy pages degrade gracefully instead of OOMing.
const MAX_LIVE_WEBVIEWS = 8;

interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
  vpW: number;
  vpH: number;
}

function cardIntersectsViewport(card: BrowserCardPosition, vp: Viewport, marginPx: number): boolean {
  const m = marginPx / vp.zoom;
  const vx = -vp.panX / vp.zoom - m;
  const vy = -vp.panY / vp.zoom - m;
  const vw = vp.vpW / vp.zoom + 2 * m;
  const vh = vp.vpH / vp.zoom + 2 * m;
  return card.x < vx + vw && card.x + card.width > vx && card.y < vy + vh && card.y + card.height > vy;
}

function agentNeedsLive(browserId: string, card: BrowserCardPosition): boolean {
  if (getActivity(browserId)) return true;
  const state = store.getState();
  const glow = state.dashboardLayout.glowingBrowserCards[browserId];
  if (glow && !glow.fading) return true;
  const sessions = state.agents.sessions as Record<string, any>;
  for (const s of Object.values(sessions)) {
    if (s.browser_id === browserId && (s.status === 'running' || s.status === 'waiting_approval')) return true;
  }
  if (card.spawned_by) {
    const parent = sessions[card.spawned_by];
    if (parent && (parent.status === 'running' || parent.status === 'waiting_approval')) return true;
  }
  return false;
}

/**
 * Swaps off-screen, agent-idle webviews for static snapshots (freeing their
 * renderer processes) and wakes them when panned back into view. Agent-driven
 * cards are never touched; commands to a suspended card wake it via
 * browserCommandHandler's awaitWebview.
 */
export function useWebviewSuspend(
  browserCards: Record<string, BrowserCardPosition>,
  panX: number,
  panY: number,
  zoom: number,
  viewportRef: React.RefObject<HTMLDivElement>,
) {
  const dispatch = useAppDispatch();
  const suspended = useAppSelector((s) => s.dashboardLayout.suspendedBrowserCards);
  const vpRef = useRef<Viewport>({ panX, panY, zoom, vpW: 1200, vpH: 800 });

  // Window resize changes the viewport without touching pan/zoom/cards; tick so
  // the evaluation below reruns, or a shrunken window never suspends anything.
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    if (!isElectron) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setResizeTick((n) => n + 1), 300);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (t) clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    const el = viewportRef.current;
    vpRef.current = {
      panX, panY, zoom,
      vpW: el ? el.clientWidth : 1200,
      vpH: el ? el.clientHeight : 800,
    };

    const liveCount = Object.keys(browserCards).filter((id) => !suspended[id]).length;
    let budget = MAX_LIVE_WEBVIEWS - liveCount;
    const parked = Object.keys(suspended)
      .map((id) => [id, browserCards[id]] as const)
      .filter(([, card]) => !!card)
      .sort((a, b) => distFromCenter(a[1], vpRef.current) - distFromCenter(b[1], vpRef.current));
    for (const [id, card] of parked) {
      if (agentNeedsLive(id, card)) {
        dispatch(resumeBrowserCard(id));
        budget--;
        continue;
      }
      if (budget <= 0) continue;
      const bigEnough = card.width * zoom >= RESUME_MIN_CARD_PX;
      if (bigEnough && cardIntersectsViewport(card, vpRef.current, RESUME_MARGIN_PX)) {
        dispatch(resumeBrowserCard(id));
        budget--;
      }
    }

    const timer = setTimeout(async () => {
      const isSuspended = (id: string) => !!store.getState().dashboardLayout.suspendedBrowserCards[id];
      for (const [id, card] of Object.entries(browserCards)) {
        if (isSuspended(id)) continue;
        if (cardIntersectsViewport(card, vpRef.current, SUSPEND_MARGIN_PX)) continue;
        if (agentNeedsLive(id, card)) continue;
        const dataUrl = await captureCard(id, card);
        // The capture await yielded; conditions may have changed under us.
        if (!dataUrl || cardIntersectsViewport(card, vpRef.current, SUSPEND_MARGIN_PX) || agentNeedsLive(id, card)) continue;
        dispatch(suspendBrowserCard({ browserId: id, dataUrl }));
      }

      const countLive = () => Object.keys(browserCards).filter((id) => !isSuspended(id)).length;
      if (countLive() > MAX_LIVE_WEBVIEWS) {
        const candidates = Object.entries(browserCards)
          .filter(([id, card]) => !isSuspended(id) && !agentNeedsLive(id, card))
          .sort((a, b) => distFromCenter(b[1], vpRef.current) - distFromCenter(a[1], vpRef.current));
        for (const [id, card] of candidates) {
          if (countLive() <= MAX_LIVE_WEBVIEWS) break;
          const dataUrl = await captureCard(id, card);
          if (!dataUrl || agentNeedsLive(id, card)) continue;
          dispatch(suspendBrowserCard({ browserId: id, dataUrl }));
        }
      }
    }, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [browserCards, suspended, panX, panY, zoom, viewportRef, dispatch, resizeTick]);
}

function distFromCenter(card: BrowserCardPosition, vp: Viewport): number {
  const cx = (-vp.panX + vp.vpW / 2) / vp.zoom;
  const cy = (-vp.panY + vp.vpH / 2) / vp.zoom;
  const dx = card.x + card.width / 2 - cx;
  const dy = card.y + card.height / 2 - cy;
  return dx * dx + dy * dy;
}

async function captureCard(id: string, card: BrowserCardPosition): Promise<string | null> {
  const wv = getWebview(id, card.activeTabId);
  if (!wv) return null;
  try {
    if (wv.isLoading()) return null;
    const url = wv.getURL();
    if (!url || url === 'about:blank') return null;
    const image = await wv.capturePage();
    if (image.isEmpty()) return null;
    return image.getSize().width > SNAPSHOT_MAX_W
      ? image.resize({ width: SNAPSHOT_MAX_W, quality: 'good' }).toDataURL()
      : image.toDataURL();
  } catch {
    return null;
  }
}
