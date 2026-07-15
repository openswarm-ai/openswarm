import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import {
  suspendBrowserCard,
  resumeBrowserCard,
  type BrowserCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import { getWebview } from '@/shared/browserRegistry';
import { getActivity, isAnyBrowserBusy } from '@/shared/browserCommandHandler';
import { isKeepAliveBrowser } from '@/shared/browserFocus';
import { captureTabCapsule } from '@/shared/browserStateCapsule';

const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

const SETTLE_MS = 800;
// Hysteresis: suspend only well past the edge, resume just past it, so a card sitting on the boundary never flaps between webview and snapshot.
const SUSPEND_MARGIN_PX = 320;
const RESUME_MARGIN_PX = 96;
const SNAPSHOT_MAX_W = 1024;
// Below this on-screen width a live page is indistinguishable from its placeholder, so booted-parked cards on a zoomed-out canvas stay parked until zoomed into.
const RESUME_MIN_CARD_PX = 220;
// Hard ceiling on simultaneous live webviews; past it the farthest-from-center non-agent card gets parked, so heavy pages degrade gracefully instead of OOMing.
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

// Grace after terminal so an agent whose status blips completed->running between back-to-back turns can't lose its browser in the gap.
const WORKING_GRACE_MS = 20_000;
const lastWorkingAt = new Map<string, number>();

function sessionIsWorking(s: { id?: string; status?: string } | undefined): boolean {
  if (!s) return false;
  if (s.status === 'running' || s.status === 'waiting_approval') {
    if (s.id) lastWorkingAt.set(s.id, Date.now());
    return true;
  }
  const t = s.id ? lastWorkingAt.get(s.id) : undefined;
  if (lastWorkingAt.size > 300) {
    for (const [k, v] of lastWorkingAt) if (Date.now() - v > WORKING_GRACE_MS) lastWorkingAt.delete(k);
  }
  return t !== undefined && Date.now() - t < WORKING_GRACE_MS;
}

function agentNeedsLive(browserId: string, card: BrowserCardPosition): boolean {
  if (getActivity(browserId)) return true;
  const state = store.getState();
  const sessions = state.agents.sessions as Record<string, any>;
  // A glow holds the card live only while its SOURCE session is still working: a stuck glow (chat unmounted at finish never fades it) must not pin a renderer forever.
  const glow = state.dashboardLayout.glowingBrowserCards[browserId];
  if (glow && !glow.fading && sessionIsWorking(sessions[glow.sourceId])) return true;
  for (const s of Object.values(sessions)) {
    if (s.browser_id === browserId && sessionIsWorking(s)) return true;
  }
  if (card.spawned_by && sessionIsWorking(sessions[card.spawned_by])) return true;
  return false;
}

// Chrome never discards an audible tab: a card playing music off-screen keeps playing instead of going silent mid-song.
function cardIsAudible(browserId: string, card: BrowserCardPosition): boolean {
  for (const tab of card.tabs ?? []) {
    try {
      if (getWebview(browserId, tab.id)?.isCurrentlyAudible?.()) return true;
    } catch {
      // A detached/dying webview reads as silent.
    }
  }
  return false;
}

// A card we must never snapshot-swap: an agent is driving it, it's in the keep-alive set (recently used), or it's playing audio. Suspending destroys the webContents (sessionStorage, playback), the things we're preserving.
function mustStayLive(browserId: string, card: BrowserCardPosition): boolean {
  return agentNeedsLive(browserId, card) || isKeepAliveBrowser(browserId) || cardIsAudible(browserId, card);
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

  // Window resize changes the viewport without touching pan/zoom/cards; tick so the evaluation below reruns, or a shrunken window never suspends anything.
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
      if (mustStayLive(id, card)) {
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
      await refreshVisibleFrames(browserCards, isSuspended, vpRef.current);
      for (const [id, card] of Object.entries(browserCards)) {
        if (isSuspended(id)) continue;
        if (cardIntersectsViewport(card, vpRef.current, SUSPEND_MARGIN_PX)) continue;
        if (mustStayLive(id, card)) continue;
        // An empty dataUrl still suspends (placeholder renders): a card whose capture hangs/fails must not keep its renderer alive forever.
        const dataUrl = await captureForSuspend(id, card);
        // The capture await yielded; conditions may have changed under us.
        if (cardIntersectsViewport(card, vpRef.current, SUSPEND_MARGIN_PX) || mustStayLive(id, card)) continue;
        dispatch(suspendBrowserCard({ browserId: id, dataUrl }));
      }

      const countLive = () => Object.keys(browserCards).filter((id) => !isSuspended(id)).length;
      if (countLive() > MAX_LIVE_WEBVIEWS) {
        const candidates = Object.entries(browserCards)
          .filter(([id, card]) => !isSuspended(id) && !mustStayLive(id, card))
          .sort((a, b) => distFromCenter(b[1], vpRef.current) - distFromCenter(a[1], vpRef.current));
        for (const [id, card] of candidates) {
          if (countLive() <= MAX_LIVE_WEBVIEWS) break;
          const dataUrl = await captureForSuspend(id, card);
          if (mustStayLive(id, card)) continue;
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

// capturePage on an already-off-screen webview can HANG forever (Electron 42/Viz stops producing frames for unpainted guests), and one hung await used to wedge the whole suspend pass, silently disabling suspension for every card. Bound it hard.
const CAPTURE_TIMEOUT_MS = 1500;

// Last frame grabbed while each card was still VISIBLE: off-screen webviews can't produce frames, so this cache is what makes suspended cards show a real screenshot instead of the bare title placeholder.
const lastFrames = new Map<string, { dataUrl: string; at: number }>();
const FRAME_TTL_MS = 45_000;
const FRAME_CACHE_CAP = 30;

function rememberFrame(id: string, dataUrl: string): void {
  lastFrames.set(id, { dataUrl, at: Date.now() });
  if (lastFrames.size > FRAME_CACHE_CAP) {
    const oldest = [...lastFrames.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) lastFrames.delete(oldest[0]);
  }
}

async function refreshVisibleFrames(
  cards: Record<string, BrowserCardPosition>,
  isSuspended: (id: string) => boolean,
  vp: Viewport,
): Promise<void> {
  // Capturing while an agent drives a webview is the SharedImage-mailbox crash class; skip the whole pass.
  if (isAnyBrowserBusy()) return;
  for (const [id, card] of Object.entries(cards)) {
    if (isSuspended(id)) continue;
    if (!cardIntersectsViewport(card, vp, 0)) continue;
    const prev = lastFrames.get(id);
    if (prev && Date.now() - prev.at < FRAME_TTL_MS) continue;
    const dataUrl = await captureCard(id, card);
    if (dataUrl) rememberFrame(id, dataUrl);
  }
}

async function captureForSuspend(id: string, card: BrowserCardPosition): Promise<string> {
  // Chrome-style state capsules first (sessionStorage + scroll per tab), so resume restores logins instead of wiping them; JS still runs off-screen even when frames don't.
  for (const tab of card.tabs ?? []) {
    await captureTabCapsule(getWebview(id, tab.id), tab.id);
  }
  const live = await captureCard(id, card);
  if (live) {
    rememberFrame(id, live);
    return live;
  }
  return lastFrames.get(id)?.dataUrl ?? '';
}

async function captureCard(id: string, card: BrowserCardPosition): Promise<string> {
  const wv = getWebview(id, card.activeTabId);
  if (!wv) return '';
  try {
    if (wv.isLoading()) return '';
    const url = wv.getURL();
    if (!url || url === 'about:blank') return '';
    const image = await Promise.race([
      wv.capturePage(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)),
    ]);
    if (!image || image.isEmpty()) return '';
    return image.getSize().width > SNAPSHOT_MAX_W
      ? image.resize({ width: SNAPSHOT_MAX_W, quality: 'good' }).toDataURL()
      : image.toDataURL();
  } catch {
    return '';
  }
}
