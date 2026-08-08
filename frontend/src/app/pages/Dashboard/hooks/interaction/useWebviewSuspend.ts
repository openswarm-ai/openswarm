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
import { getMinimizedShot } from '../../desktop/minimizedShots';
import { guestBudgetHasRoom, wireBrowserLiveCounter } from '@/shared/appWebviewBudget';
import { useAppHidden } from './useAppHidden';
import { cardIntersectsViewport, distFromCenter, type Viewport } from './suspendGeometry';

const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

// Feed the global guest budget the live-browser count, so apps and browsers share ONE ceiling.
wireBrowserLiveCounter(() => {
  const dl = store.getState().dashboardLayout;
  return Object.keys(dl.browserCards).filter((id) => !dl.suspendedBrowserCards[id]).length;
});

const SETTLE_MS = 800;
// Hysteresis: suspend only well past the edge, resume just past it, so a card sitting on the boundary never flaps between webview and snapshot.
const SUSPEND_MARGIN_PX = 320;
const RESUME_MARGIN_PX = 96;
const SNAPSHOT_MAX_W = 1024;
// Below this on-screen width a live page is indistinguishable from its placeholder, so booted-parked cards on a zoomed-out canvas stay parked until zoomed into.
const RESUME_MIN_CARD_PX = 220;
// ...and the same rule on the way OUT. This used to be one-directional: a card too small to read was
// never woken, but one already awake stayed awake however far you zoomed out, so eight webviews kept
// rendering full pages into ~100px boxes on a zoomed-out canvas. That is the app's biggest GPU cost
// paid for pixels nobody can read, and it is the pressure that makes Chromium evict the wash tiles
// (the two-tone background band). Lower than the resume bar on purpose, so a card sitting near the
// threshold cannot flap between live and snapshot.
const SUSPEND_MAX_CARD_PX = 150;
// Hard ceiling on simultaneous live webviews; past it the farthest-from-center non-agent card gets parked, so heavy pages degrade gracefully instead of OOMing.
const MAX_LIVE_WEBVIEWS = 8;

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

// Parked in the minimize rail: the card renders off-canvas behind a frozen still, so a live renderer
// sitting behind it is pure waste (same call DashboardViewCard already makes for app previews).
function isMinimized(browserId: string): boolean {
  return !!store.getState().dashboardLayout.minimizedCards[browserId];
}

// Restoring from the rail flies the camera to the card, and that flight outlives one settle beat; without a grace the off-screen rule re-parks the card mid-flight and it flickers back to a dead snapshot.
const RESTORE_GRACE_MS = 4000;
const restoredAt = new Map<string, number>();

function withinRestoreGrace(browserId: string): boolean {
  const t = restoredAt.get(browserId);
  for (const [k, v] of restoredAt) if (Date.now() - v > RESTORE_GRACE_MS) restoredAt.delete(k);
  return t !== undefined && Date.now() - t < RESTORE_GRACE_MS;
}

// A card we must never snapshot-swap: an agent is driving it, it's in the keep-alive set (recently used), or it's playing audio. Suspending destroys the webContents (sessionStorage, playback), the things we're preserving.
function mustStayLive(browserId: string, card: BrowserCardPosition): boolean {
  // The shield class marks a live card/marquee drag: suspending a browser MID-DRAG unmounts the
  // handle holding the pointer capture, its up event dies with it, and the stuck drag state then
  // re-pins the card to the cursor on every pan (the card that "follows the camera" bug).
  if (document.body.classList.contains('dashboard-marquee-active')) return true;
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
  const minimized = useAppSelector((s) => s.dashboardLayout.minimizedCards);
  const prevMinimizedRef = useRef<Record<string, boolean>>({});
  const vpRef = useRef<Viewport>({ panX, panY, zoom, vpW: 1200, vpH: 800 });

  // Hidden long enough = the user left; park every idle renderer, working agents keep theirs.
  const appHidden = useAppHidden(isElectron);

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

    const wasMinimized = prevMinimizedRef.current;
    prevMinimizedRef.current = minimized;

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
      // While the app is hidden nothing idle resumes; the same loop wakes in-view cards on return.
      if (appHidden || budget <= 0 || minimized[id]) continue;
      // Un-minimizing is an explicit "give it back", so it wakes the card wherever the camera happens to be pointing.
      if (wasMinimized[id]) {
        restoredAt.set(id, Date.now());
        // Straight into a tile (rail -> fullscreen): attaching the guest is a SYNCHRONOUS 60-290ms
        // main-thread IPC, and firing it inside the landing + camera glide is the browser-only jank
        // (DOM windows never pay it). The snapshot is pixel-identical, so let it do the landing and
        // attach once the motion is over; re-minimized in the gap means never attach at all.
        if (store.getState().dashboardLayout.tiledCards[id]) {
          window.setTimeout(() => {
            const dl = store.getState().dashboardLayout;
            if (!dl.minimizedCards[id] && dl.suspendedBrowserCards[id]) dispatch(resumeBrowserCard(id));
          }, 600);
        } else {
          dispatch(resumeBrowserCard(id));
        }
        budget--;
        continue;
      }
      const bigEnough = card.width * zoom >= RESUME_MIN_CARD_PX;
      // Passive wake also asks the GLOBAL budget: a free browser slot means nothing if apps already
      // hold the machine at its ceiling. Explicit restores and working agents above never ask.
      if (bigEnough && cardIntersectsViewport(card, vpRef.current, RESUME_MARGIN_PX) && guestBudgetHasRoom()) {
        dispatch(resumeBrowserCard(id));
        budget--;
      }
    }

    const timer = setTimeout(async () => {
      const isSuspended = (id: string) => !!store.getState().dashboardLayout.suspendedBrowserCards[id];
      // Read live, not off the effect's closure: this re-runs after an await, and the user can restore a card mid-capture.
      const wantsPark = (id: string, card: BrowserCardPosition): boolean =>
        appHidden
        || isMinimized(id)
        // Read zoom off the ref, never the closure: this fires 800ms after the effect ran, and
        // zooming out is exactly the gesture that should be parking these.
        || (!withinRestoreGrace(id) && card.width * vpRef.current.zoom < SUSPEND_MAX_CARD_PX)
        || (!withinRestoreGrace(id) && !cardIntersectsViewport(card, vpRef.current, SUSPEND_MARGIN_PX));
      await refreshVisibleFrames(browserCards, isSuspended, vpRef.current);
      for (const [id, card] of Object.entries(browserCards)) {
        if (isSuspended(id)) continue;
        if (!wantsPark(id, card)) continue;
        if (mustStayLive(id, card)) continue;
        // An empty dataUrl still suspends (placeholder renders): a card whose capture hangs/fails must not keep its renderer alive forever.
        const dataUrl = await captureForSuspend(id, card);
        // The capture await yielded; conditions may have changed under us.
        if (!wantsPark(id, card) || mustStayLive(id, card)) continue;
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
  }, [browserCards, suspended, minimized, panX, panY, zoom, viewportRef, dispatch, resizeTick, appHidden]);
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
    if (isMinimized(id)) continue;
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
  // A minimized card is already parked off-canvas and will never paint again, so asking it for a frame
  // just burns the capture timeout; the shot frozen on the way in is the only real one it has.
  const live = isMinimized(id) ? '' : await captureCard(id, card);
  if (live) {
    rememberFrame(id, live);
    return live;
  }
  return lastFrames.get(id)?.dataUrl ?? getMinimizedShot(id) ?? '';
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
