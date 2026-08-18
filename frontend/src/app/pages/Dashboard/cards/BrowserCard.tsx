import React, { useState, useRef, useCallback, useEffect } from 'react';
import { isElectron as detectElectron } from '@/shared/isElectron';
import { store } from '@/shared/state/store';
import { requestWebviewAttachSlot, releaseWebviewAttachSlot } from './webviewAttachQueue';
import { createPortal } from 'react-dom';
import { subscribeLiveDrag } from '../hooks/interaction/liveDragChannel';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Fade from '@mui/material/Fade';
import LanguageIcon from '@mui/icons-material/Language';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import LockIcon from '@mui/icons-material/Lock';
import SearchIcon from '@mui/icons-material/Search';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { report } from '@/shared/serviceClient';
import RunInDesktopMessage from '@/app/components/RunInDesktopMessage';
import {
  setBrowserCardPosition,
  setBrowserCardSize,
  resumeBrowserCard,
  cancelBrowserCardEnding,
  addBrowserTab,
  removeBrowserTab,
  setActiveBrowserTab,
  updateBrowserTabUrl,
  updateBrowserTabTitle,
  updateBrowserTabFavicon,
  reorderBrowserTab,
  moveBrowserTab,
  recordClosedCard,
  toggleMinimizeCard,
  setBrowserDocked,
  GRID_GAP,
  type BrowserTab,
} from '@/shared/state/dashboardLayoutSlice';
import WindowControls from './WindowControls';
import { useTiledCard } from './useTiledCard';
import { useCardTiling } from './useCardTiling';
import { getMinimizedShot, saveMinimizedShot } from '../desktop/minimizedShots';
import { setBrowserFollowing } from '../desktop/followingBrowsers';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import { createSelector } from '@reduxjs/toolkit';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { handleApproval, expandSession } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  registerWebview,
  unregisterWebview,
  setActiveTab as setRegistryActiveTab,
  registerPendingLoad,
  wakePendingLoad,
  hasDomReady,
  type BrowserWebview,
} from '@/shared/browserRegistry';
import { captureBrowserShot } from '@/shared/captureBrowserShot';
import { setLastInteractedBrowser } from '@/shared/browserFocus';
import { isAgentDrivenBrowser } from '@/shared/isAgentDrivenBrowser';
import { registerCapsuleForRestore } from '@/shared/browserStateCapsule';
import BrowserFindBar from './BrowserFindBar';
import { openCardContextMenu, isNativeMenuTarget } from '../desktop/openCardContextMenu';
import { browserCardMenuRows, browserTabMenuRows } from './browserCardMenuRows';
import { useBrowserActivity } from '@/shared/useBrowserActivity';
import {
  getActionLabel, readDataDocument, recoverCardOffDataWall, isAnyBrowserBusy,
} from '@/shared/browserCommandHandler';
import { resolveInput, isGoogleSearch } from '@/shared/resolveUrl';
import BrowserAgentOverlay from './BrowserAgentOverlay';

// Fixed light chrome for the macOS-window look; deliberately theme-independent, like a real browser window.
const CHROME_BG = '#f2eff5';
const CHROME_SURFACE = '#ffffff';
const CHROME_PAGE = '#faf9fc';
const CHROME_BORDER = 'rgba(0,0,0,0.08)';
const CHROME_TEXT = '#3c3744';
const CHROME_TEXT_MUTED = '#8a8494';

import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { RESIZE_HANDLE_DEFS, RESIZE_CURSOR, type ResizeDir } from './cardResizeHandles';


// Pill-preview capture cadence: fast until the card has handed the pill a frame, slow upkeep after.
const PILL_SHOT_WARMUP_MS = 800;
const PILL_SHOT_REFRESH_MS = 5000;
const PILL_SHOT_WARMUP_MAX_MS = 8000;
const MIN_W = 400;
const MIN_H = 300;



// Windows gets the real, agent-controllable <webview> + CDP, same as Mac. History: the <webview> tag mount used to segfault the renderer during Chromium's commit phase on the old CastLabs Electron 40 build (0xC0000005, since 1.1.55, same crash family as the ablated <input type=file> and Framer-Motion subtrees), so Windows fell back to a non-scriptable iframe (no CDP, and most sites send X-Frame-Options) which the agent can't drive. The Electron 42 bump (v42.0.0+wvcus) fixed the segfault: faithful in-process probes on the real 42 binary mount the webview - including two at once inside a transformed/contained canvas, with real HTTPS navigation and reload churn - with zero host-renderer crash. Crash-safe by construction (electron/CLAUDE.md: mitigations must fail quiet in BOTH directions, and crash guards never boot-loop). If some Windows config still segfaults on mount, a pending marker - armed synchronously during the first browser-card render, i.e. before the <webview> commits, see armWindowsWebviewPending - survives the crash. A leftover marker at the next launch means that mount never reached dom-ready, so we count it and stand down to the safe iframe this launch; after WIN_WV_MAX such crashes we stay on the iframe for good. A clean dom-ready clears the marker and the counter. Escape hatch: openswarm_win_webview_off='1' forces the iframe; clear openswarm_win_webview_crashes to retry after a lockout.
const WIN_WV_OFF = 'openswarm_win_webview_off';
const WIN_WV_PENDING = 'openswarm_win_webview_pending';
const WIN_WV_CRASHES = 'openswarm_win_webview_crashes';
const WIN_WV_MAX = 2;

function windowsWebviewEnabled(): boolean {
  try {
    if (localStorage.getItem(WIN_WV_OFF) === '1') return false;
    const crashes = parseInt(localStorage.getItem(WIN_WV_CRASHES) || '0', 10) || 0;
    if (crashes >= WIN_WV_MAX) return false;
    if (localStorage.getItem(WIN_WV_PENDING)) {
      // A webview mounted last launch but never reached dom-ready: it crashed on commit. Count it and use the safe iframe this launch (retry next launch).
      localStorage.removeItem(WIN_WV_PENDING);
      localStorage.setItem(WIN_WV_CRASHES, String(crashes + 1));
      console.warn(`[win-webview] mount crashed last launch (${crashes + 1}/${WIN_WV_MAX}); using the safe iframe this launch.`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Armed once, synchronously, during the first browser-card render so it persists even if the <webview> commit segfaults (a ref/effect would run too late, after the crash). Cleared on dom-ready by markWindowsWebviewSurvived. No-op on Mac / iframe.
let _winWvPendingArmed = false;
function armWindowsWebviewPending(): void {
  if (_winWvPendingArmed) return;
  _winWvPendingArmed = true;
  try { localStorage.setItem(WIN_WV_PENDING, String(Date.now())); } catch {}
}

// Clears the pending marker + crash counter once a webview survives to dom-ready; no-op on Mac (never set).
function markWindowsWebviewSurvived(): void {
  try {
    localStorage.removeItem(WIN_WV_PENDING);
    localStorage.removeItem(WIN_WV_CRASHES);
  } catch {}
}

const isWindows = navigator.userAgent.includes('Windows');
const inElectron = detectElectron();
const isElectron = inElectron && (!isWindows || windowsWebviewEnabled());

// Keep the openswarm/<ver> product token: Google's sign-in flags a BARE Chrome UA as not-genuine-Chrome and blocks it ("browser may not be secure"), but tolerates a UA carrying a product token. Only the Electron token must go (that one Google hard-blocks).
const chromeUserAgent = navigator.userAgent
  .replace(/\s*Electron\/\S+/i, '');

// Persistent partition so browser-card logins/cookies/localStorage outlive a reload or quit. MUST match BROWSER_PARTITION in electron/main.js, which configures permissions + iframe header-strip on this exact partition.
const BROWSER_PARTITION = 'persist:openswarm-browser';

// Sync exposure set at preload boot; async API fallback for older builds.
const webviewPreloadPath: string | undefined = isElectron
  ? ((window as any).__OPENSWARM_WEBVIEW_PRELOAD__
      || (window as any).openswarm?.getWebviewPreloadPath?.())
  : undefined;


type WebviewElement = BrowserWebview;

interface TabLocalState {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface Props {
  browserId: string;
  tabs: BrowserTab[];
  activeTabId: string;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  cmdHeld?: boolean;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragActive?: boolean;
  // Belongs to a non-active dashboard but kept mounted-hidden so its webContents + sessionStorage survive the switch.
  keepAliveHidden?: boolean;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser', shiftKey: boolean, originTarget?: EventTarget | null) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  cardZOrder?: number;
  onDoubleClick?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
}


const BrowserCard: React.FC<Props> = ({
  browserId, tabs, activeTabId, cardX, cardY, cardWidth, cardHeight, getCanvasState, cmdHeld = false,
  isSelected = false, isHighlighted = false, keepAliveHidden = false, multiDragActive = false, onCardSelect, onDragStart, onDragMove, onDragEnd,
  cardZOrder = 0, onDoubleClick, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Read via ref inside the webview-attach effect so a new onDoubleClick identity doesn't re-run that effect (which would re-register the webview).
  const onDoubleClickRef = useRef(onDoubleClick);
  onDoubleClickRef.current = onDoubleClick;
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;

  // Memoized so the all-sessions scan reruns only when sessions actually change, not on every layout/drag dispatch at 60Hz.
  const selectBrowserAgentSession = React.useMemo(
    () => createSelector(
      [(state: { agents: { sessions: Record<string, any> } }) => state.agents.sessions],
      (sessions) => {
        const matches = Object.values(sessions).filter(
          (s: any) => s.browser_id === browserId && s.mode === 'browser-agent'
            && (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'completed' || s.status === 'error' || s.status === 'stopped'),
        );
        return matches.find((s: any) => s.status === 'running' || s.status === 'waiting_approval') ?? matches[matches.length - 1] ?? null;
      },
    ),
    [browserId],
  );
  const browserAgentSession = useAppSelector(selectBrowserAgentSession);
  const isMinimized = useAppSelector((s) => Boolean(s.dashboardLayout.minimizedCards[browserId]));
  const commitCardPosition = useCallback((x: number, y: number) => {
    dispatch(setBrowserCardPosition({ browserId, x, y }));
  }, [dispatch, browserId]);
  const tiling = useCardTiling({ cardId: browserId, getCanvasState, commitPosition: commitCardPosition });
  const tileZone = tiling.zone;
  const isTiled = !!tileZone;
  const onTile = tiling.applyZone;

  // ---- In-chat dock: while docked to an expanded chat, the card overlays the chat's slot rect.
  // Pure geometry in the shared canvas layer (same DOM node), so the webview never remounts.
  const dockedTo = useAppSelector((state) => state.dashboardLayout.browserCards[browserId]?.docked_to ?? null);
  // Ownership survives slot theft (one docked surface per chat steals docked_to): the collapse
  // tuck still claims a card this chat SPAWNED unless the user dragged it free (Eric's round-trip repro).
  const tuckTo = useAppSelector((state) => {
    const bc = state.dashboardLayout.browserCards[browserId];
    if (!bc) return null;
    return bc.docked_to ?? ((bc.spawned_by && !bc.freed) ? bc.spawned_by : null);
  });
  const dockParentCard = useAppSelector((state) => (tuckTo ? state.dashboardLayout.cards[tuckTo] ?? null : null));
  const dockParentExpanded = useAppSelector((state) => (tuckTo ? state.agents.expandedSessionIds.includes(tuckTo) : false));
  const dockParentTiled = useAppSelector((state) => (dockedTo ? state.dashboardLayout.tiledCards[dockedTo] : undefined));
  const [dockRect, setDockRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // The slot now lives INSIDE the transcript scroller (inline like a tool output), and a live webview cannot be clipped by a scroll container, so the mini hides when its slot scrolls mostly out of view instead.
  const [dockVisible, setDockVisible] = useState(true);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dockedTo || !dockParentCard || !dockParentExpanded) { setDockRect(null); setDockVisible(true); return undefined; }
    let scrollHost: Element | null = null;
    let hookedSlot: Element | null = null;
    let scrollRaf = 0;
    const onScroll = (): void => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; measure(); }); };
    const ro = new ResizeObserver(() => measure());
    const mo = new MutationObserver(() => onScroll());
    const measure = (): void => {
      const slot = document.querySelector(`[data-browser-slot="${dockedTo}"]`);
      const layer = rootElRef.current?.parentElement;
      // The slot lives in the transcript's virtualized window, so it can UNMOUNT while scrolled far away; keep the last rect and hide, because nulling it here popped the card back to its stale canvas home.
      if (!slot || !layer) { setDockVisible(false); return; }
      // The slot mounts a beat after docking (and remounts with chat re-renders), so observers hook the live node whenever it changes; a one-shot hookup at effect time reliably missed it and froze the rect.
      if (slot !== hookedSlot) {
        ro.disconnect();
        ro.observe(slot);
        if (slot.parentElement) ro.observe(slot.parentElement);
        scrollHost?.removeEventListener('scroll', onScroll);
        scrollHost?.removeEventListener('load', measure, true);
        scrollHost = slot.closest('[data-chat-transcript]');
        scrollHost?.addEventListener('scroll', onScroll, { passive: true });
        // An image/iframe finishing load ABOVE the slot shifts it with no scroll, resize, or mutation; load doesn't bubble but it does capture.
        scrollHost?.addEventListener('load', measure, true);
        // Streaming appends move/remount the slot without resizing or scrolling anything observed; the mutation observer is what keeps the mini glued during a live turn.
        mo.disconnect();
        if (scrollHost) mo.observe(scrollHost, { childList: true, subtree: true });
        hookedSlot = slot;
      }
      const z = getCanvasState().zoom || 1;
      const lr = layer.getBoundingClientRect();
      let sr: { left: number; top: number; right: number; bottom: number; width: number; height: number } = slot.getBoundingClientRect();
      // Hard containment: the mini must NEVER paint outside its chat card, whatever a mid-animation or mismeasured slot claims; clamp to the card's real bounds and hide when the overlap collapses.
      const parentEl = document.querySelector(`[data-select-id="${dockedTo}"]`);
      if (parentEl) {
        const pr = parentEl.getBoundingClientRect();
        const left = Math.max(sr.left, pr.left);
        const top = Math.max(sr.top, pr.top);
        const right = Math.min(sr.right, pr.right);
        const bottom = Math.min(sr.bottom, pr.bottom);
        if (right - left < 60 || bottom - top < 60) { setDockVisible(false); return; }
        sr = { left, top, right, bottom, width: right - left, height: bottom - top };
      }
      // Slot and card share the transformed layer, so layer-relative coords are camera-invariant.
      setDockRect({ x: (sr.left - lr.left) / z, y: (sr.top - lr.top) / z, w: sr.width / z, h: sr.height / z });
      if (scrollHost) {
        const cr = scrollHost.getBoundingClientRect();
        const overlap = Math.min(sr.bottom, cr.bottom) - Math.max(sr.top, cr.top);
        // A webview can't be clipped, so anything short of fully-in-view would lap the composer or header; the slot's frozen-shot backdrop is what shows (and clips) while partial.
        setDockVisible(overlap >= sr.height - 24);
      } else {
        setDockVisible(true);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    // A RO only fires on slot RESIZE; the chat tiling/untiling MOVES the slot without resizing the
    // window, so re-measure on camera writes + settle timers or the docked card lags behind.
    window.addEventListener('openswarm:canvas-pan-changed', measure);
    document.addEventListener('visibilitychange', measure);
    const timers = [60, 250, 700].map((ms) => window.setTimeout(measure, ms));
    // The slot lives in the WINDOWED transcript and remounts without firing any of the events
    // above; it announces itself on mount now, which retired a 150ms forever-poll that forced a
    // layout read ~7x/sec per docked mini even while nothing moved (measure once per real change).
    const onSlotMounted = (e: Event): void => {
      if ((e as CustomEvent).detail?.id === dockedTo) measure();
    };
    window.addEventListener('openswarm:browser-slot-mounted', onSlotMounted);
    // A 1s belt bounds any move-without-event gap nobody has named yet. Only alive while a mini is
    // docked, so it costs one layout read per second during active docking instead of 6.7/sec forever.
    const belt = window.setInterval(measure, 1000);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('openswarm:canvas-pan-changed', measure);
      document.removeEventListener('visibilitychange', measure);
      window.removeEventListener('openswarm:browser-slot-mounted', onSlotMounted);
      scrollHost?.removeEventListener('load', measure, true);
      scrollHost?.removeEventListener('scroll', onScroll);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      timers.forEach((tm) => window.clearTimeout(tm));
      window.clearInterval(belt);
    };
    // dockParentCard x/y/w/h are re-measure triggers: the slot's client rect moves with the chat card.
  }, [dockedTo, dockParentExpanded, dockParentTiled, dockParentCard?.x, dockParentCard?.y, dockParentCard?.width, dockParentCard?.height, getCanvasState, dockParentCard]);
  const dockParentZOverride = useAppSelector((state) => (dockedTo ? state.dashboardLayout.zOrders[dockedTo] : undefined));
  const dockParentZ = dockParentZOverride ?? dockParentCard?.zOrder ?? 0;
  const zOverride = useAppSelector((state) => state.dashboardLayout.zOrders[browserId]);

  // The slot's frozen-shot backdrop and the live overlay must never BOTH paint (the clamped overlay leaves margins where a misaligned copy of the page peeks through), so the card stamps its live state onto the slot and the slot's CSS hides the shot while live.
  const overlayLiveRef = useRef(false);
  useEffect(() => {
    if (!dockedTo) return undefined;
    const stamp = (): void => {
      const slot = document.querySelector(`[data-browser-slot="${dockedTo}"]`);
      slot?.setAttribute('data-mini-live', overlayLiveRef.current ? '1' : '0');
    };
    stamp();
    const t = window.setInterval(stamp, 400);
    return () => {
      window.clearInterval(t);
      document.querySelector(`[data-browser-slot="${dockedTo}"]`)?.setAttribute('data-mini-live', '0');
    };
  }, [dockedTo]);

  // The chat drags on a per-frame compositor transform, but dock geometry only re-measures at settle; ride the same drag channel imperatively or the mini visibly trails its own chat.
  const hasDockRect = !!dockRect;
  useEffect(() => {
    if (!dockedTo || !hasDockRect) return undefined;
    // Clear only after having followed: the old unconditional else cleared translate on EVERY
    // drag frame of every other card, and would fight the multi-drag channel's writes.
    let wasFollowing = false;
    const off = subscribeLiveDrag((info) => {
      const el = rootElRef.current;
      if (!el) return;
      if (info && info.cardId === dockedTo) {
        el.style.translate = `${info.dx}px ${info.dy}px`;
        wasFollowing = true;
      } else if (wasFollowing) {
        el.style.translate = '';
        wasFollowing = false;
      }
    });
    return () => {
      off();
      const el = rootElRef.current;
      if (el) el.style.translate = '';
    };
  }, [dockedTo, hasDockRect]);

  const suspendedSnap = useAppSelector((state) => state.dashboardLayout.suspendedBrowserCards[browserId]);
  const endingState = useAppSelector((state) => state.dashboardLayout.endingBrowserCards[browserId]);

  // An agent's browser is what its collapsed chat shows as a pill preview, so this card owes the pill a frozen frame.
  const pillShotOwner = useAppSelector((state) => {
    const card = state.dashboardLayout.browserCards[browserId];
    return card?.docked_to ?? card?.spawned_by ?? null;
  });
  const [pillShotSettled, setPillShotSettled] = useState(() => !!getMinimizedShot(browserId));

  // Arm the Windows webview crash-safety marker synchronously, before React commits the <webview> below. Cleared on dom-ready; a leftover marker next launch tells windowsWebviewEnabled() the mount crashed, so it falls back to the iframe. MUST skip parked cards: they render no webview, so dom-ready never fires and a stale marker reads as a phantom crash that locks Windows out of webviews.
  if (isElectron && isWindows && !suspendedSnap) armWindowsWebviewPending();

  const activity = useBrowserActivity(browserId);
  const agentRunning = browserAgentSession?.status === 'running';
  const agentActive = activity.active || agentRunning;
  const agentAction = activity.action;
  const lastAction = activity.lastAction;

  const [tabLocalStates, setTabLocalStates] = useState<Record<string, TabLocalState>>({});
  // Electron webviews can't trigger OS platform auth; preload sends "passkey-detected" and we explain via modal.
  const [passkeyDialogOpen, setPasskeyDialogOpen] = useState(false);
  const [crashedTabs, setCrashedTabs] = useState<Set<string>>(new Set());
  // Ctrl/Cmd+F find bar; focusSignal re-focuses the input each time Ctrl+F fires while it's already open.
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusSignal, setFindFocusSignal] = useState(0);
  const updateTabLocal = useCallback((tabId: string, update: Partial<TabLocalState>) => {
    setTabLocalStates((prev) => {
      const existing = prev[tabId] ?? { loading: false, canGoBack: false, canGoForward: false };
      return {
        ...prev,
        [tabId]: { ...existing, ...update },
      };
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeUrl = activeTab?.url || '';
  const activeTitle = activeTab?.title || '';
  const activeLocal = tabLocalStates[activeTabId] || { loading: false, canGoBack: false, canGoForward: false };

  const [urlBarValue, setUrlBarValue] = useState(activeUrl);
  useEffect(() => {
    setUrlBarValue(activeUrl);
  }, [activeUrl, activeTabId]);

  const webviewMap = useRef<Map<string, WebviewElement>>(new Map());

  // Electron attaches a guest with a SYNCHRONOUS renderer IPC, so a dashboard that mounts N cards
  // puts N blocking round-trips in one frame (measured: 4755ms over 40 long tasks at 18 cards).
  // Waiting for a slot spreads them one per frame; nothing unmounts, so sessions are untouched.
  const [attachSlotReady, setAttachSlotReady] = useState(false);
  useEffect(() => {
    if (attachSlotReady) return undefined;
    return requestWebviewAttachSlot(() => setAttachSlotReady(true));
  }, [attachSlotReady]);
  const initializedTabs = useRef(new Set<string>());
  const tabBarRef = useRef<HTMLDivElement>(null);
  // Some pages (Zillow's map) rewrite their own URL many times a second, across did-navigate-in-page AND did-stop-loading; throttle the persisted URL mirror so each tick can't fan out to a full dashboard save + webview suspend re-eval. Leading edge keeps a real navigation's URL immediate.
  const urlChurnThrottle = useRef<Map<string, { lastAt: number; timer: ReturnType<typeof setTimeout> | null }>>(new Map());
  const throttleUrlMirror = useCallback((tabId: string, run: () => void) => {
    const URL_CHURN_MS = 1500;
    const m = urlChurnThrottle.current;
    let entry = m.get(tabId);
    if (!entry) { entry = { lastAt: 0, timer: null }; m.set(tabId, entry); }
    const e = entry;
    const since = Date.now() - e.lastAt;
    if (since >= URL_CHURN_MS) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      e.lastAt = Date.now();
      run();
    } else if (!e.timer) {
      e.timer = setTimeout(() => { e.lastAt = Date.now(); e.timer = null; run(); }, URL_CHURN_MS - since);
    }
  }, []);

  // Kept current so the mount-time load decision (eager vs deferred) reads the live active tab, not a stale closure (the load effect keys on the tab SET, not activeTabId).
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    setRegistryActiveTab(browserId, activeTabId);
    // Switching to a deferred background tab loads it now; no-op if it already loaded or hasn't reached dom-ready yet (onReady then loads it eagerly because it's the active tab).
    const wv = webviewMap.current.get(activeTabId);
    if (wv) wakePendingLoad(wv);
  }, [browserId, activeTabId]);

  // Open the find bar when AppShell routes a Ctrl/Cmd+F to this browser; re-trigger re-focuses the input.
  useEffect(() => {
    const onFind = (e: Event) => {
      if ((e as CustomEvent).detail?.browserId !== browserId) return;
      setFindOpen(true);
      setFindFocusSignal((n) => n + 1);
    };
    window.addEventListener('openswarm:browser-find', onFind as EventListener);
    return () => window.removeEventListener('openswarm:browser-find', onFind as EventListener);
  }, [browserId]);

  // A resumed webview remounts at about:blank; dropping the init markers lets doLoad re-fire.
  useEffect(() => {
    if (suspendedSnap) initializedTabs.current.clear();
  }, [suspendedSnap]);

  // Spawned cards get marked "ending" by WebSocketManager when the parent agent finishes; show the fade pill for ~3s, then dispatch the real remove. Keep clears the flag and the cleanup below cancels the pending remove.
  useEffect(() => {
    if (!endingState) return;
    const timer = setTimeout(() => {
      removeBrowserCardCleanly(browserId, dispatch);
    }, 3000);
    return () => clearTimeout(timer);
  }, [endingState, browserId, dispatch]);

  const tabIdKey = tabs.map((t) => t.id).join(',');
  useEffect(() => {
    if (!isElectron) return;
    const cleanups: (() => void)[] = [];

    for (const tab of tabs) {
      const wv = webviewMap.current.get(tab.id);
      if (!wv) continue;
      const tabId = tab.id;

      registerWebview(browserId, tabId, wv);

      if (!initializedTabs.current.has(tabId)) {
        initializedTabs.current.add(tabId);
        const targetUrl = tab.url;
        const doLoad = () => {
          // Reaching dom-ready proves the webview survived Chromium's commit phase (the historical Windows mount segfault). Clear the crash-safety marker.
          if (isWindows) markWindowsWebviewSurvived();
          // Registered BEFORE loadURL so the guest preload can sync-take it at document-start: a resumed tab gets its sessionStorage back Chrome-style instead of a logged-out reload. No-op when no capsule exists.
          registerCapsuleForRestore(wv, tabId);
          wv.loadURL(targetUrl)
            .then(async () => {
              // If this card's own entry URL is a raw JSON/API endpoint, it paints an unreadable data
              // wall; get it onto a real page. (The agent-navigate path is handled in handleNavigate;
              // this covers the initial load, which never goes through the command handler.)
              if (await readDataDocument(wv)) recoverCardOffDataWall(wv, targetUrl);
            })
            .catch(() => {});
          try {
            // Chrome-parity pinch: locked at (1,1) Electron DROPS trackpad pinch entirely, so Figma/Miro/Maps never saw the ctrl+wheel their canvas zoom listens for. Pages that preventDefault it (Figma) own the zoom; plain pages get Chrome's pinch magnify.
            (wv as any).setVisualZoomLevelLimits?.(1, 3);
            (wv as any).setZoomFactor?.(1);
          } catch (_) {}
        };
        // Lazy tabs: only the VISIBLE tab loads its page on mount. A background tab stays at
        // about:blank (deferred) so a many-tab card doesn't load every page at once; it's woken
        // the instant it becomes active OR an agent command resolves it (browserRegistry wake).
        const onReady = () => {
          if (tabId === activeTabIdRef.current) doLoad();
          else registerPendingLoad(wv, targetUrl, doLoad);
          // Release AFTER this card's own post-attach work (loadURL, capsule, zoom limits), not
          // before: releasing first let that work run against the next card's attach and put six
          // long tasks in one open where an isolated attach produces two.
          releaseWebviewAttachSlot();
        };
        wv.addEventListener('dom-ready', onReady, { once: true });
        cleanups.push(() => wv.removeEventListener('dom-ready', onReady));
        // The preload re-runs on every full navigation, so re-tag the guest each dom-ready: browser surfaces keep ctrl/meta+wheel (pinch) IN the page instead of forwarding it to canvas zoom.
        const tagSurface = () => { try { (wv as any).send?.('openswarm:set-surface', { kind: 'browser' }); } catch (_) {} };
        tagSurface();
        wv.addEventListener('dom-ready', tagSurface);
        cleanups.push(() => wv.removeEventListener('dom-ready', tagSurface));
        // A dead browser card used to report NOTHING: the guest process vanishes, the surface goes
        // blank, and no crash log or telemetry ever mentions it (verified by forcing a crash).
        const onGuestGone = (e: Event): void => {
          const d = e as Event & { reason?: string; exitCode?: number };
          report('process', 'webview_gone', { reason: d.reason ?? 'crashed', exit_code: d.exitCode ?? null });
          // Reporting alone left a black rectangle on the board; the guest is dead either way, so a reload can only win (ENG-322).
          window.setTimeout(() => { try { (wv as unknown as { reload?: () => void }).reload?.(); } catch (_) {} }, 800);
        };
        wv.addEventListener('render-process-gone', onGuestGone);
        wv.addEventListener('crashed', onGuestGone);
        cleanups.push(() => {
          wv.removeEventListener('render-process-gone', onGuestGone);
          wv.removeEventListener('crashed', onGuestGone);
        });
      }

      // Every guest sits at about:blank before its real load (lazy tabs never leave it); mirroring
      // that would overwrite the tab's actual url, and a tab dragged into a fresh card then loads
      // blank and stops looking like the page it is.
      const mirrorUrl = () => {
        const live = wv.getURL();
        if (!live || live === 'about:blank') return;
        dispatch(updateBrowserTabUrl({ browserId, tabId, url: live }));
      };
      const onNavigate = () => {
        updateTabLocal(tabId, {
          canGoBack: wv.canGoBack(),
          canGoForward: wv.canGoForward(),
        });
        throttleUrlMirror(tabId, mirrorUrl);
      };

      const onIpcMessage = (e: any) => {
        // No unconditional log; forwarded webview-console messages were causing 100s of host warns/sec and main-thread stalls.
        if (e?.channel === 'passkey-detected') {
          setPasskeyDialogOpen(true);
        } else if (e?.channel === 'browser-dblclick') {
          onDoubleClickRef.current?.(browserId, 'browser');
        } else if (e?.channel === 'canvas-wheel-zoom') {
          const payload = e.args?.[0] || {};
          const wvRect = wv.getBoundingClientRect();
          const fx = typeof payload.fracX === 'number' ? payload.fracX : 0.5;
          const fy = typeof payload.fracY === 'number' ? payload.fracY : 0.5;
          window.dispatchEvent(
            new CustomEvent('openswarm:canvas-wheel-zoom', {
              detail: {
                deltaY: payload.deltaY ?? 0,
                deltaMode: payload.deltaMode ?? 0,
                clientX: wvRect.left + fx * wvRect.width,
                clientY: wvRect.top + fy * wvRect.height,
              },
            }),
          );
        } else if (e?.channel === 'canvas-wheel-pan') {
          // Plain wheel inside an unselected webview never bubbles out; the preload forwards it here so the dashboard canvas can pan.
          const payload = e.args?.[0] || {};
          window.dispatchEvent(
            new CustomEvent('openswarm:canvas-wheel-pan', {
              detail: {
                deltaX: payload.deltaX ?? 0,
                deltaY: payload.deltaY ?? 0,
                deltaMode: payload.deltaMode ?? 0,
              },
            }),
          );
        } else if (e?.channel === 'app-clicked') {
          // In-guest mousedown: a page click never reaches the host document, so this IPC is how a webview-content click marks this browser as last-interacted (drives Ctrl+R/zoom/tab targeting) and selected (spawn-beside anchor).
          // The guest fires this for the AGENT's clicks too; those must not hijack targeting (or dictation's fallback types into the agent's page).
          if (!isAgentDrivenBrowser(browserId)) {
            setLastInteractedBrowser(browserId);
            window.dispatchEvent(new CustomEvent('openswarm:browser-guest-select', { detail: { browserId } }));
          }
        }
      };

      const onTitleUpdate = () => {
        dispatch(updateBrowserTabTitle({ browserId, tabId, title: wv.getTitle() }));
      };

      // Only a real main-frame document navigation drives the loading bar. did-start-loading is webContents-level and fires for every sub-frame/ad-iframe load, so busy sites (news, ad-heavy) kept re-sweeping the bar after the page was done; in-place pushState navs (Zillow's map) are instant and need no bar.
      const onLoadStart = (e: any) => {
        if (!e || e.isMainFrame === false || e.isInPlace) return;
        updateTabLocal(tabId, { loading: true });
      };
      const onLoadStop = () => {
        updateTabLocal(tabId, { loading: false });
        onNavigate();
        onTitleUpdate();
        setCrashedTabs((prev) => {
          if (!prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      };
      const onProcessGone = () => {
        setCrashedTabs((prev) => {
          if (prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.add(tabId);
          return next;
        });
      };

      // A failed/aborted main-frame load never fires did-stop-loading, and initializedTabs is already set so doLoad won't re-arm: without this the card sits blank with the spinner running forever. errorCode -3 is ERR_ABORTED (a superseded nav), not a failure.
      const onDidFailLoad = (e: any) => {
        if (!e || e.isMainFrame === false) return;
        updateTabLocal(tabId, { loading: false });
        if (e.errorCode && e.errorCode !== -3) onProcessGone();
      };

      const onFaviconUpdate = (e: any) => {
        const favicons = e.favicons || (e.detail && e.detail.favicons);
        if (favicons?.[0]) {
          dispatch(updateBrowserTabFavicon({ browserId, tabId, favicon: favicons[0] }));
        }
      };

      // Exit fullscreen before popup spawns; Chromium compositor shifts and parent surface goes black silently otherwise.
      const onNewWindow = () => {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
      };

      wv.addEventListener('did-navigate', onNavigate);
      wv.addEventListener('did-navigate-in-page', onNavigate);
      wv.addEventListener('page-title-updated', onTitleUpdate);
      wv.addEventListener('did-start-navigation', onLoadStart);
      wv.addEventListener('did-stop-loading', onLoadStop);
      wv.addEventListener('page-favicon-updated', onFaviconUpdate);
      wv.addEventListener('ipc-message', onIpcMessage as any);
      wv.addEventListener('new-window', onNewWindow as any);
      wv.addEventListener('render-process-gone', onProcessGone as any);
      wv.addEventListener('crashed', onProcessGone as any);
      wv.addEventListener('did-fail-load', onDidFailLoad as any);
      cleanups.push(() => {
        unregisterWebview(browserId, tabId);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
        wv.removeEventListener('page-title-updated', onTitleUpdate);
        wv.removeEventListener('did-start-navigation', onLoadStart);
        wv.removeEventListener('did-stop-loading', onLoadStop);
        wv.removeEventListener('page-favicon-updated', onFaviconUpdate);
        wv.removeEventListener('ipc-message', onIpcMessage as any);
        wv.removeEventListener('new-window', onNewWindow as any);
        wv.removeEventListener('render-process-gone', onProcessGone as any);
        wv.removeEventListener('crashed', onProcessGone as any);
        wv.removeEventListener('did-fail-load', onDidFailLoad as any);
        const churn = urlChurnThrottle.current.get(tabId);
        if (churn?.timer) { clearTimeout(churn.timer); churn.timer = null; }
      });
    }

    return () => cleanups.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
    // attachSlotReady is load-bearing: the <webview> elements do not exist until the attach queue
    // releases this card, so without it this effect runs once against an empty map, registers no
    // dom-ready listener, and every card after the first sits at about:blank forever.
  }, [tabIdKey, browserId, dispatch, updateTabLocal, suspendedSnap, throttleUrlMirror, attachSlotReady]);

  const navigate = useCallback((targetUrl: string) => {
    const finalUrl = resolveInput(targetUrl);
    setUrlBarValue(finalUrl);
    const wv = webviewMap.current.get(activeTabId);
    if (isElectron && wv) {
      wv.loadURL(finalUrl).catch((err: Error) => {
        if (!err.message?.includes('ERR_ABORTED')) console.error('Navigation failed:', err);
      });
    }
    dispatch(updateBrowserTabUrl({ browserId, tabId: activeTabId, url: finalUrl }));
    if (suspendedSnap) dispatch(resumeBrowserCard(browserId));
  }, [browserId, activeTabId, dispatch, suspendedSnap]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(urlBarValue);
    }
  }, [navigate, urlBarValue]);

  const handleBack = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewMap.current.get(activeTabId)?.goBack();
  }, [activeTabId]);

  const handleForward = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewMap.current.get(activeTabId)?.goForward();
  }, [activeTabId]);

  const handleRefresh = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    webviewMap.current.get(activeTabId)?.reload();
  }, [activeTabId]);

  // The window X. An agent's browser dragged OUT of its chat (undocked, owner still on canvas) used
  // to be destroyed with no way back (ENG-251); its X now returns it inline to the chat instead.
  // Everything else (a user's own browser, or one still docked and closed from inside the chat) is a
  // real close, recorded to recently-closed so Cmd+Shift+T still recovers it.
  const handleWindowClose = useCallback(() => {
    const st = store.getState();
    const card = st.dashboardLayout.browserCards[browserId];
    const owner = card?.spawned_by;
    const fading = !!st.dashboardLayout.endingBrowserCards[browserId];
    if (owner && !fading && !card?.docked_to && st.dashboardLayout.cards[owner]) {
      dispatch(setBrowserDocked({ browserId, dockedTo: owner }));
      return;
    }
    dispatch(recordClosedCard({ kind: 'browser', id: browserId }));
    removeBrowserCardCleanly(browserId, dispatch);
  }, [dispatch, browserId]);

  const handleAddTab = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(addBrowserTab({ browserId, url: browserHomepage }));
  }, [dispatch, browserId, browserHomepage]);

  // Yellow light: snapshot the live page first so the right-edge stack shows a real thumbnail,
  // then park the card (webContents stays mounted, same as the keep-alive off-screen park).
  const handleMinimize = useCallback(() => {
    // 250ms: captures land in ~100-200ms while the card is still visible, and a snappy minimize
    // beats a perfect thumbnail.
    void captureBrowserShot(browserId, 250)
      .then((shot) => { if (shot) saveMinimizedShot(browserId, shot); })
      .finally(() => dispatch(toggleMinimizeCard({ cardId: browserId })));
  }, [dispatch, browserId]);

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Closing the last tab destroys the whole card, so record it as a browser-card close (reopen brings the card back), not a tab close.
    if (tabs.length <= 1) dispatch(recordClosedCard({ kind: 'browser', id: browserId }));
    else dispatch(recordClosedCard({ kind: 'tab', id: tabId, browserId }));
    dispatch(removeBrowserTab({ browserId, tabId }));
  }, [dispatch, browserId, tabs.length]);

  const handleSwitchTab = useCallback((tabId: string) => {
    dispatch(setActiveBrowserTab({ browserId, tabId }));
  }, [dispatch, browserId]);

  const tabDragRef = useRef<{
    tabId: string;
    startX: number;
    startY: number;
    isDragging: boolean;
    detached: boolean;
  } | null>(null);
  const swapCooldown = useRef(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragTabOffset, setDragTabOffset] = useState(0);
  // Ghost pill following the cursor while a tab is dragged OUT of the strip (Push 6: drop on another card = absorbed, drop on canvas = new browser card).
  const [detachGhost, setDetachGhost] = useState<{ x: number; y: number } | null>(null);
  const DETACH_PX = 48;

  const handleTabPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    // A right-click still fires pointerdown; arming the drag here would capture the pointer under the menu.
    if (e.button !== 0) return;
    const tabId = (e.currentTarget as HTMLElement).getAttribute('data-tab-id');
    if (!tabId) return;
    tabDragRef.current = { tabId, startX: e.clientX, startY: e.clientY, isDragging: false, detached: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleTabPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.isDragging && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    drag.isDragging = true;
    setDragTabId(drag.tabId);

    // Pulling clear of the strip detaches the tab; hovering back over the strip re-attaches (Chrome behavior).
    const barRect = tabBarRef.current?.getBoundingClientRect();
    if (barRect) {
      const outside = e.clientY < barRect.top - DETACH_PX || e.clientY > barRect.bottom + DETACH_PX
        || e.clientX < barRect.left - DETACH_PX || e.clientX > barRect.right + DETACH_PX;
      const backInside = e.clientY >= barRect.top && e.clientY <= barRect.bottom
        && e.clientX >= barRect.left && e.clientX <= barRect.right;
      if (!drag.detached && outside) drag.detached = true;
      else if (drag.detached && backInside) drag.detached = false;
    }
    if (drag.detached) {
      setDetachGhost({ x: e.clientX, y: e.clientY });
      setDragTabOffset(0);
      return;
    }
    setDetachGhost(null);
    setDragTabOffset(dx);

    if (swapCooldown.current) return;
    const bar = tabBarRef.current;
    if (!bar) return;

    const draggedEl = bar.querySelector(`[data-tab-id="${drag.tabId}"]`) as HTMLElement | null;
    if (!draggedEl) return;
    const rect = draggedEl.getBoundingClientRect();
    const center = rect.left + rect.width / 2 + dx;
    const currentIdx = tabs.findIndex((t) => t.id === drag.tabId);

    if (currentIdx < tabs.length - 1) {
      const nextId = tabs[currentIdx + 1].id;
      const nextEl = bar.querySelector(`[data-tab-id="${nextId}"]`) as HTMLElement | null;
      if (nextEl) {
        const nr = nextEl.getBoundingClientRect();
        if (center > nr.left + nr.width / 2) {
          dispatch(reorderBrowserTab({ browserId, tabId: drag.tabId, toIndex: currentIdx + 1 }));
          drag.startX = e.clientX;
          setDragTabOffset(0);
          swapCooldown.current = true;
          requestAnimationFrame(() => { swapCooldown.current = false; });
        }
      }
    }

    if (currentIdx > 0) {
      const prevId = tabs[currentIdx - 1].id;
      const prevEl = bar.querySelector(`[data-tab-id="${prevId}"]`) as HTMLElement | null;
      if (prevEl) {
        const pr = prevEl.getBoundingClientRect();
        if (center < pr.left + pr.width / 2) {
          dispatch(reorderBrowserTab({ browserId, tabId: drag.tabId, toIndex: currentIdx - 1 }));
          drag.startX = e.clientX;
          setDragTabOffset(0);
          swapCooldown.current = true;
          requestAnimationFrame(() => { swapCooldown.current = false; });
        }
      }
    }
  }, [tabs, browserId, dispatch]);

  const handleTabPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    if (!drag.isDragging) {
      handleSwitchTab(drag.tabId);
    } else if (drag.detached) {
      // Hit-test the drop point: another browser card absorbs the tab; empty canvas spins off a new card there.
      const hit = document.elementsFromPoint(e.clientX, e.clientY)
        .map((el) => (el as HTMLElement).closest?.('[data-select-type="browser-card"]') as HTMLElement | null)
        .find((el) => el && el.getAttribute('data-select-id') !== browserId);
      const targetId = hit?.getAttribute('data-select-id') || null;
      if (targetId) {
        dispatch(moveBrowserTab({ fromBrowserId: browserId, tabId: drag.tabId, toBrowserId: targetId }));
      } else {
        // Screen -> canvas: derive the transform origin from this card's own strip (screenX = originX + canvasX * zoom).
        const barRect = tabBarRef.current?.getBoundingClientRect();
        if (barRect) {
          const z = getCanvasState().zoom;
          const dropX = (e.clientX - (barRect.left - cardX * z)) / z - 40;
          const dropY = (e.clientY - (barRect.top - cardY * z)) / z - 16;
          dispatch(moveBrowserTab({ fromBrowserId: browserId, tabId: drag.tabId, x: dropX, y: dropY }));
        }
      }
    }
    tabDragRef.current = null;
    setDragTabId(null);
    setDragTabOffset(0);
    setDetachGhost(null);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [handleSwitchTab, dispatch, browserId, cardX, cardY, getCanvasState]);

  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Fullscreen has no drag (macOS rule); same title-wiggle untile hazard as AgentCard.
    if (tiling.zone === 'fullscreen') return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getCanvasState();
    const popped = tiling.untileForDrag(e.clientX, e.clientY, cardWidth);
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: popped?.x ?? dockRect?.x ?? cardX, origY: popped?.y ?? dockRect?.y ?? cardY,
      startPanX: cs.panX, startPanY: cs.panY,
    };
    if (popped) setLocalDragPos(popped);
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    onDragStart?.(browserId, 'browser');
  }, [cardX, cardY, cardWidth, onDragStart, browserId, getCanvasState, tiling, dockRect]);

  const recomputeDragPos = useCallback(() => {
    const ds = dragState.current;
    if (!ds || !didDrag.current) return;
    const { clientX, clientY } = lastPointerRef.current;
    const rawDx = clientX - ds.startX;
    const rawDy = clientY - ds.startY;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - ds.startPanX) / z;
    const panDy = (cs.panY - ds.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({ x: ds.origX + dx, y: ds.origY + dy });
    onDragMove?.(dx, dy, clientX, clientY);
  }, [onDragMove, getCanvasState]);

  // Edge-pan/wheel-zoom moves the camera without a React commit; the pan-changed event is the live signal to re-pin the card to the cursor.
  useEffect(() => {
    if (!isDragging) return;
    const onPanChange = () => {
      if (didDrag.current) recomputeDragPos();
    };
    window.addEventListener('openswarm:canvas-pan-changed', onPanChange);
    return () => window.removeEventListener('openswarm:canvas-pan-changed', onPanChange);
  }, [isDragging, recomputeDragPos]);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    recomputeDragPos();
  }, [recomputeDragPos]);

  const finalizeDrag = useCallback((clientX: number, clientY: number, shiftKey: boolean) => {
    if (!dragState.current) return;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = (clientX - dragState.current.startX) / z - panDx;
    const dy = (clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      // Snap to 24px grid (Shift bypasses).
      if (!shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }
      // Dropping over a chat docks the browser INTO it; anywhere else undocks to a free card.
      const { clientX: hx, clientY: hy } = lastPointerRef.current;
      const under = document.elementsFromPoint(hx, hy);
      const slotHit = under.map((el) => (el as HTMLElement).closest?.('[data-browser-slot]') as HTMLElement | null).find(Boolean);
      const chatHit = under.map((el) => (el as HTMLElement).closest?.('[data-select-type="agent-card"]') as HTMLElement | null).find(Boolean);
      const dockTarget = slotHit?.getAttribute('data-browser-slot') || chatHit?.getAttribute('data-select-id') || null;
      if (dockTarget) {
        dispatch(setBrowserDocked({ browserId, dockedTo: dockTarget }));
        // Chats live as collapsed pills by default; docking into a pill used to park the card at
        // -100000 instantly (it just vanished). Open the chat so the drop visibly lands in the slot.
        dispatch(expandSession(dockTarget));
      } else if (dockedTo) {
        dispatch(setBrowserDocked({ browserId, dockedTo: null }));
      }
      dispatch(setBrowserCardPosition({
        browserId,
        x: finalX,
        y: finalY,
      }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
  }, [dispatch, browserId, onDragEnd, getCanvasState, dockedTo]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    finalizeDrag(e.clientX, e.clientY, e.shiftKey);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* capture already gone */ }
  }, [finalizeDrag]);

  // A release the header never hears (pointercancel, capture lost to a mid-drag remount, up eaten
  // outside the window) used to leave dragState set forever; the pan-repin then glued the card to
  // the CAMERA until reload. Any of these now commits the drag at the last known pointer.
  const abortDrag = useCallback(() => {
    if (!dragState.current) return;
    finalizeDrag(lastPointerRef.current.clientX, lastPointerRef.current.clientY, true);
  }, [finalizeDrag]);

  useEffect(() => {
    if (!isDragging) return undefined;
    const onUp = (e: PointerEvent): void => { if (dragState.current) finalizeDrag(e.clientX, e.clientY, e.shiftKey); };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', abortDrag);
    window.addEventListener('blur', abortDrag);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', abortDrag);
      window.removeEventListener('blur', abortDrag);
    };
  }, [isDragging, finalizeDrag, abortDrag]);

  const resizeRef = useRef<{
    dir: ResizeDir; startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const popped = tiling.untileForResize();
      if (popped) setLocalResize(popped);
      resizeRef.current = {
        dir, startX: e.clientX, startY: e.clientY,
        origX: popped?.x ?? cardX, origY: popped?.y ?? cardY, origW: popped?.w ?? cardWidth, origH: popped?.h ?? cardHeight,
      };
      setIsResizing(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [cardX, cardY, cardWidth, cardHeight, tiling],
  );

  const computeResize = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return null;
      const { dir, startX, startY, origX, origY, origW, origH } = resizeRef.current;
      const zoom = getCanvasState().zoom;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      let newX = origX, newY = origY, newW = origW, newH = origH;
      if (dir.includes('e')) newW = origW + dx;
      if (dir.includes('w')) { newW = origW - dx; newX = origX + dx; }
      if (dir.includes('s')) newH = origH + dy;
      if (dir.includes('n')) { newH = origH - dy; newY = origY + dy; }
      if (newW < MIN_W) { if (dir.includes('w')) newX = origX + origW - MIN_W; newW = MIN_W; }
      if (newH < MIN_H) { if (dir.includes('n')) newY = origY + origH - MIN_H; newH = MIN_H; }
      return { x: newX, y: newY, w: newW, h: newH };
    },
    [getCanvasState],
  );

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const result = computeResize(e);
      if (result) setLocalResize(result);
    },
    [computeResize],
  );

  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const result = computeResize(e);
    if (result) {
      dispatch(setBrowserCardPosition({ browserId, x: result.x, y: result.y }));
      dispatch(setBrowserCardSize({ browserId, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, browserId]);

  const displayX = localResize?.x ?? localDragPos?.x ?? cardX;
  const displayY = localResize?.y ?? localDragPos?.y ?? cardY;
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && multiDragActive);
  // During a drag, move the card by a COMPOSITOR transform, not left/top layout: while edge-panning, the canvas transform and the card's left/top update land a frame apart, and the webview's guest surface follows the transform immediately while left/top relayouts late, so the browser visibly shimmers back and forth. A transform for the drag delta rides the same compositor path as the canvas pan, so they move together in one frame.
  const dragging = isDragging && !!localDragPos && !localResize;
  const dragTx = dragging ? displayX - cardX : 0;
  const dragTy = dragging ? displayY - cardY : 0;

  const isSecure = activeUrl.startsWith('https://');
  const isSearch = isGoogleSearch(activeUrl);

  const accentColor = c.accent.primary;

  const glowingBrowserCards = useAppSelector((s) => s.dashboardLayout.glowingBrowserCards);
  const browserGlow = glowingBrowserCards[browserId];

  // Drop the glow the moment the agent's done (fading) so it eases off via the 0.4s box-shadow transition, instead of holding full until the entry clears. The tether arrow already keyed off `fading`; the card never did.
  const showGlow = !!browserGlow && !browserGlow.fading;

  const agentBorder = isHighlighted
    ? `2px solid ${c.accent.primary}`
    : agentActive
      ? `2px solid ${accentColor}`
      : showGlow
        ? `2px solid ${accentColor}`
        : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`;

  const innerGlow = showGlow && !agentActive
    ? `, inset 0 0 30px ${accentColor}25, inset 0 0 60px ${accentColor}10`
    : '';

  const agentShadow = isHighlighted
    ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
    : agentActive
      ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15`
      : showGlow
        ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15${innerGlow}`
        : isDragging || isResizing
          ? c.shadow.lg
          : isSelected
            ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
            : c.shadow.md;

  // Exactly one card owns a chat's dock (highest z wins): a dead browser whose dock the layout sync re-asserts must never stack under its replacement in the same slot.
  const dockOwnerId = useAppSelector((state) => {
    if (!dockedTo) return null;
    let bestId: string | null = null;
    let bestZ = -Infinity;
    for (const b of Object.values(state.dashboardLayout.browserCards)) {
      if (b.docked_to !== dockedTo) continue;
      const z = b.zOrder || 0;
      if (z > bestZ) { bestZ = z; bestId = b.browser_id; }
    }
    return bestId;
  });
  const isDockOwner = dockOwnerId === browserId;
  const dockActive = !!dockRect && isDockOwner && !dragging && !localResize && !isTiled && !keepAliveHidden && !isMinimized;
  // Docked in intent but no slot rect yet (slot not mounted, or windowed out before first measure), OR docked but out-elected by a newer dock owner: hide rather than flash the card at its stale canvas home.
  const dockPending = !!dockedTo && !!dockParentCard && (!isDockOwner || (dockParentExpanded && !dockRect)) && !dragging && !isTiled && !isMinimized && !keepAliveHidden;
  overlayLiveRef.current = dockActive && dockVisible && !dockPending;
  // An agent can only SEE a page the compositor is drawing, and Chromium draws nothing at all for a
  // guest parked at left:-100000. Measured in one window: a card on screen captured in 58ms while
  // the same card parked timed out on guest capturePage, on host capturePage AND on CDP
  // captureScreenshot. So a browser its agent is still working stays on the canvas, collapsed
  // parent or not, and re-parks when the run ends. Watching it work is the point of the canvas.
  const agentDriving = browserAgentSession?.status === 'running' || browserAgentSession?.status === 'waiting_approval';
  // Chat collapsed: its docked browser parks off-screen and lives on as the pill's frozen shot,
  // instead of teleporting back to wherever it sat before docking. The park waits for that shot:
  // an off-screen guest never paints again, and capturePage on one never settles (Electron 42).
  const wantsDockPark = !!tuckTo && !!dockParentCard && !dockParentExpanded && !agentDriving && !dragging && !isTiled && !isMinimized && !keepAliveHidden;
  const dockParked = wantsDockPark && pillShotSettled;
  // A docked browser's stored x/y is the beside-chat spot captured AT DOCK TIME, so moving the chat
  // leaves it behind. An agent-driven browser skips the park (above), so it painted itself over
  // wherever the chat USED to be, sometimes exactly on the chat's own header, where a press grabs the
  // browser and drags that instead of the chat. Follow the parent's live rect while it is collapsed.
  // NO exclusions for dragging/resize/capture-wait: any gap here rendered the FULL-SIZE card
  // halfway up the pill during transient states (thinking, mid-capture, mid-drag; Eric's shots x3).
  // Collapsed parent = parked or 320px miniature, at every stage, no third state.
  const followsParent = !!tuckTo && !!dockParentCard && !dockParentExpanded && !dockParked
    && !isTiled && !isMinimized && !keepAliveHidden;
  // Tell the pill a live miniature is underneath it, so it suppresses its own artifacts instead of
  // stacking a widget/frozen shot on top of the browser (Eric's overlap screenshots).
  useEffect(() => {
    if (tuckTo) setBrowserFollowing(tuckTo, browserId, followsParent);
    return () => { if (tuckTo) setBrowserFollowing(tuckTo, browserId, false); };
  }, [followsParent, tuckTo, browserId]);
  // Under the pill, not beside it: beside-at-pill-height read as a detached window fighting the
  // pill's ring and shadow (Eric, 2026-08-17); tucked below the collapsed pill it reads as the
  // chat's own attachment, the same visual contract as the docked mini inside an expanded chat.
  const followX = followsParent && dockParentCard ? dockParentCard.x : null;
  const followY = followsParent && dockParentCard ? dockParentCard.y + 52 : null;
  const tiledSize = useTiledCard({ cardId: browserId, zone: tileZone, active: !keepAliveHidden && !isMinimized && !dockParked, originX: displayX, originY: displayY, getCamera: getCanvasState });
  const pillShotPaintable = !!pillShotOwner && !dockParked && !isMinimized && !keepAliveHidden && !suspendedSnap;
  useEffect(() => {
    if (!pillShotPaintable) return undefined;
    let cancelled = false;
    let inFlight = false;
    const freeze = (): void => {
      // Capturing a webview an agent is mid-command on is the SharedImage-mailbox renderer crash.
      if (inFlight || isAnyBrowserBusy()) return;
      const wv = webviewMap.current.get(activeTabId);
      // capturePage THROWS on a guest that hasn't reached dom-ready yet, and an uncaught one here kills the whole card tree.
      if (!wv || !hasDomReady(wv)) return;
      let shot: Promise<{ isEmpty: () => boolean; toDataURL: () => string }> | undefined;
      try { shot = wv.capturePage(); } catch { return; }
      if (!shot) return;
      inFlight = true;
      shot.then((img) => {
        inFlight = false;
        if (cancelled || img.isEmpty()) return;
        saveMinimizedShot(browserId, img.toDataURL());
        setPillShotSettled(true);
      }, () => { inFlight = false; });
    };
    freeze();
    const timer = window.setInterval(freeze, pillShotSettled ? PILL_SHOT_REFRESH_MS : PILL_SHOT_WARMUP_MS);
    // A page that can never paint (dead guest, about:blank) must not camp on the canvas forever.
    const giveUp = window.setTimeout(() => setPillShotSettled(true), PILL_SHOT_WARMUP_MAX_MS);
    return () => { cancelled = true; window.clearInterval(timer); window.clearTimeout(giveUp); };
  }, [pillShotPaintable, pillShotSettled, browserId, activeTabId]);

  return (
    <Box
      ref={rootElRef}
      className="osw-card"
      data-select-type="browser-card"
      data-select-id={browserId}
      data-select-meta={JSON.stringify({ name: activeTitle || 'Browser', url: activeUrl })}
      // Marks a kept-alive card parked off-screen (it belongs to another dashboard); fit-to-view must skip it or it pans the canvas to chase it and the card bleeds onto the dashboard you're viewing.
      data-keepalive-hidden={keepAliveHidden || isMinimized || dockParked ? '1' : undefined}
      onContextMenu={(e: React.MouseEvent) => { if (isNativeMenuTarget(e)) return; openCardContextMenu(e, {
        items: browserCardMenuRows({
          browserId, dispatch, tabs, activeUrl, activeTitle, homepage: browserHomepage, tileZone, isMinimized,
          card: { x: cardX, y: cardY, width: cardWidth, height: cardHeight },
          nav: {
            reload: () => { try { webviewMap.current.get(activeTabId)?.reload(); } catch { /* webview gone */ } },
            back: () => { try { webviewMap.current.get(activeTabId)?.goBack(); } catch { /* webview gone */ } },
            forward: () => { try { webviewMap.current.get(activeTabId)?.goForward(); } catch { /* webview gone */ } },
            canGoBack: activeLocal.canGoBack,
            canGoForward: activeLocal.canGoForward,
          },
          onTile,
          onMinimize: () => (isMinimized ? dispatch(toggleMinimizeCard({ cardId: browserId })) : handleMinimize()),
          onFind: () => { setFindOpen(true); setFindFocusSignal((n) => n + 1); },
        }),
      }); }}
      onPointerDownCapture={(e: React.PointerEvent) => {
        onBringToFront?.(browserId, 'browser');
        // Capture-phase so chrome clicks (tab strip, URL bar) the children swallow still select the card; clicks inside the guest page never reach the host at all. Shift keeps the bubbled toggle path. Pass the target so URL-bar/tab presses select without yanking the camera.
        if (e.button === 0 && !e.shiftKey) onCardSelect?.(browserId, 'browser', false, e.target);
      }}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        // Pass the target here too: with pointer capture the click after a resize lands on the handle,
        // and without the target this bubbled path skipped the control carve-out and re-centered the camera.
        onCardSelect?.(browserId, 'browser', e.shiftKey, e.target);
      }}
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onDoubleClick?.(browserId, 'browser');
      }}
      sx={{
        position: 'absolute',
        // Kept-alive card from another dashboard: parked far off-screen so its webview surface can't bleed onto the dashboard you're viewing; click-through, webContents stays mounted. A dock-hidden mini (slot scrolled away) is click-through too.
        pointerEvents: keepAliveHidden || isMinimized || dockParked || dockPending || (dockActive && !dockVisible) ? 'none' : undefined,
        // contain: webview repaints don't shake neighbor cards.
        contain: 'layout style',
        // Own compositor layer so hover/paint invalidations stay contained to this card. See AgentCard for full rationale.
        willChange: 'transform',
        // Docked = a TRUE miniature: the card keeps its full-size layout and shrinks by uniform
        // transform (centered in the slot), so the page never reflows and agent clicks stay valid.
        // Resizing the webview to the slot re-rendered the page as a narrow window, which is wrong.
        left: keepAliveHidden || isMinimized || dockParked ? -100000 : (dockActive ? dockRect!.x + (dockRect!.w - displayW * Math.min(dockRect!.w / displayW, dockRect!.h / displayH)) / 2 : (followX ?? (dragging ? cardX : displayX))),
        top: dockActive ? dockRect!.y + (dockRect!.h - displayH * Math.min(dockRect!.w / displayW, dockRect!.h / displayH)) / 2 : (followY ?? (dragging ? cardY : displayY)),
        // Following a collapsed pill = a TRUE 320px miniature (uniform scale, no reflow, agent
        // coordinates stay valid), the same contract as the in-chat dock; full-size beside a pill
        // read as a detached window and buried the pill (Eric's 1.7.7 comparison).
        transform: tiledSize ? undefined : (dragging ? `translate3d(${dragTx}px, ${dragTy}px, 0)${followsParent ? ` scale(${Math.min(1, 320 / displayW)})` : ''}` : dockActive ? `scale(${Math.min(dockRect!.w / displayW, dockRect!.h / displayH)})` : followsParent ? `scale(${Math.min(1, 320 / displayW)})` : undefined),
        transformOrigin: tiledSize || dockActive || followsParent ? '0 0' : undefined,
        width: tiledSize ? tiledSize.width : displayW,
        height: tiledSize ? tiledSize.height : displayH,
        // The scale transform shrinks corner radii too (12px at 0.35x paints ~4px, reading as a cut corner next to the pill's capsule); divide by the scale so the MINIATURE'S corners stay visually 12px.
        borderRadius: tileZone === 'fullscreen' ? '12px' : dockActive ? `${Math.round(12 / Math.min(dockRect!.w / displayW, dockRect!.h / displayH))}px` : followsParent ? `${Math.round(12 / Math.min(1, 320 / displayW))}px` : `${c.radius.lg}px`,
        // Docked = an embedded block, not a floating window: a drop shadow and heavy accent frame read as a detached card pasted over the chat.
        border: dockActive || followsParent ? `1px solid ${c.border.medium}` : agentBorder,
        bgcolor: c.bg.surface,
        boxShadow: dockActive || followsParent ? 'none' : agentShadow,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: isTiled ? 999990 : (isDragging || isResizing) ? 999999 : dockActive ? (dockParentTiled ? 999991 : dockParentZ + 1) : (zOverride ?? cardZOrder),
        // The inline slot scrolls with the transcript; a webview can't be clipped by the scroller, so the mini fades out when its slot is mostly out of view instead of floating over unrelated messages.
        opacity: (dockActive && !dockVisible) || dockPending ? 0 : 1,
        transition: noTransition ? 'none' : 'box-shadow 0.4s ease, border 0.3s ease, opacity 0.14s ease',
        '&:hover .resize-handle': { opacity: 1 },
        ...(isHighlighted && {
          animation: 'card-highlight-pulse 2s ease-out forwards',
          '@keyframes card-highlight-pulse': {
            '0%': {
              boxShadow: `0 0 0 3px ${c.accent.primary}70, 0 0 24px ${c.accent.primary}50, 0 0 48px ${c.accent.primary}25`,
            },
            '25%': {
              boxShadow: `0 0 0 4px ${c.accent.primary}55, 0 0 30px ${c.accent.primary}40, 0 0 56px ${c.accent.primary}20`,
            },
            '50%': {
              boxShadow: `0 0 0 3px ${c.accent.primary}45, 0 0 22px ${c.accent.primary}30, 0 0 44px ${c.accent.primary}15`,
            },
            '75%': {
              boxShadow: `0 0 0 2px ${c.accent.primary}25, 0 0 14px ${c.accent.primary}18, 0 0 28px ${c.accent.primary}08`,
            },
            '100%': {
              boxShadow: c.shadow.md,
            },
          },
        }),
        // No glow pulse on purpose: animated box-shadow repaints card+halo every frame over a webview; the static border and tether arrow say "in use" for free.
      }}
    >

      <Box
        ref={tabBarRef}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={abortDrag}
        onLostPointerCapture={abortDrag}
        sx={{
          position: 'relative',
          zIndex: 16,
          display: 'flex',
          alignItems: 'stretch',
          // Real-browser-window chrome stays light in both app themes, like the window it imitates.
          bgcolor: agentActive ? `${accentColor}14` : CHROME_BG,
          borderBottom: `1px solid ${agentActive ? `${accentColor}30` : CHROME_BORDER}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          flexShrink: 0,
          minHeight: 34,
          userSelect: 'none',
          transition: 'background 0.3s ease',
          overflow: 'hidden',
        }}
      >
        <Box
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
          sx={{ display: 'flex', alignItems: 'center', pl: 1.25, pr: 0.75, flexShrink: 0 }}
        >
          <WindowControls
            onClose={handleWindowClose}
            onMinimize={handleMinimize}
            onTile={onTile}
            tiled={!!tileZone}
           
          />
        </Box>
        <Box
          data-card-control
          sx={{
            display: 'flex',
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isBeingDragged = tab.id === dragTabId;
            const tls = tabLocalStates[tab.id];

            return (
              <Box
                key={tab.id}
                data-tab-id={tab.id}
                onContextMenu={(e: React.MouseEvent) => openCardContextMenu(e, {
                  items: browserTabMenuRows({ browserId, dispatch, tab, tabCount: tabs.length, homepage: browserHomepage }),
                })}
                onPointerDown={handleTabPointerDown}
                onPointerMove={handleTabPointerMove}
                onPointerUp={handleTabPointerUp}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1,
                  minWidth: 0,
                  maxWidth: 180,
                  flex: '0 1 180px',
                  position: 'relative',
                  borderRight: `1px solid ${CHROME_BORDER}`,
                  bgcolor: isActive ? CHROME_SURFACE : 'transparent',
                  cursor: isBeingDragged ? 'grabbing' : 'pointer',
                  transform: isBeingDragged ? `translateX(${dragTabOffset}px)` : 'none',
                  transition: isBeingDragged ? 'none' : 'background 0.15s ease, transform 0.2s ease',
                  zIndex: isBeingDragged ? 10 : 1,
                  '&:hover': { bgcolor: isActive ? CHROME_SURFACE : 'rgba(0,0,0,0.04)' },
                  '&:hover .tab-close': { opacity: 1 },
                  ...(isActive && {
                    '&::after': {
                      content: '""',
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: '2px',
                      bgcolor: accentColor,
                    },
                  }),
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, width: 14, height: 14, justifyContent: 'center' }}>
                  {tls?.loading ? (
                    <CircularProgress size={10} thickness={5} sx={{ color: accentColor }} />
                  ) : tab.favicon ? (
                    <Box
                      component="img"
                      src={tab.favicon}
                      sx={{ width: 14, height: 14, borderRadius: '2px' }}
                      onError={(e: any) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <LanguageIcon sx={{ fontSize: 13, color: isActive ? accentColor : CHROME_TEXT_MUTED }} />
                  )}
                </Box>

                <Typography
                  sx={{
                    flex: 1,
                    fontSize: '0.6875rem',
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? CHROME_TEXT : CHROME_TEXT_MUTED,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    lineHeight: 1.2,
                  }}
                >
                  {tab.title || 'New Tab'}
                </Typography>

                <Box
                  className="tab-close"
                  onClick={(e: React.MouseEvent) => handleCloseTab(tab.id, e)}
                  onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: '4px',
                    flexShrink: 0,
                    opacity: isActive ? 0.6 : 0,
                    cursor: 'pointer',
                    transition: 'opacity 0.15s, background 0.15s',
                    '&:hover': { bgcolor: 'rgba(0,0,0,0.09)', opacity: 1 },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 10, color: CHROME_TEXT_MUTED }} />
                </Box>
              </Box>
            );
          })}

          <Box
            onClick={handleAddTab}
            onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              flexShrink: 0,
              cursor: 'pointer',
              borderRadius: '4px',
              mx: 0.25,
              my: 0.5,
              transition: 'background 0.15s',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.06)' },
            }}
          >
            <AddIcon sx={{ fontSize: 15, color: CHROME_TEXT_MUTED }} />
          </Box>
        </Box>

        {/* Right side controls */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 0.5, flexShrink: 0 }}>

        </Box>
      </Box>

      {/* ====== Navigation bar ====== */}
      <Box
        data-card-control="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.5,
          py: 0.25,
          bgcolor: CHROME_PAGE,
          borderBottom: `1px solid ${CHROME_BORDER}`,
          flexShrink: 0,
        }}
      >
        {/* No tooltips on back/forward/reload: every browser on earth uses these arrows, so the label
            teaches nothing and the popup lands right on top of the page you are trying to read. */}
        <IconButton
          size="small"
          aria-label="Back"
          onClick={handleBack}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!activeLocal.canGoBack}
          sx={{ color: CHROME_TEXT_MUTED, p: 0.4, '&:hover': { color: CHROME_TEXT } }}
        >
          <ArrowBackIcon sx={{ fontSize: 15 }} />
        </IconButton>

        <IconButton
          size="small"
          aria-label="Forward"
          onClick={handleForward}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!activeLocal.canGoForward}
          sx={{ color: CHROME_TEXT_MUTED, p: 0.4, '&:hover': { color: CHROME_TEXT } }}
        >
          <ArrowForwardIcon sx={{ fontSize: 15 }} />
        </IconButton>

        <IconButton
          size="small"
          aria-label="Reload"
          onClick={handleRefresh}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ color: CHROME_TEXT_MUTED, p: 0.4, '&:hover': { color: CHROME_TEXT } }}
        >
          <RefreshIcon sx={{ fontSize: 15 }} />
        </IconButton>

        {/* URL bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            gap: 0.5,
            ml: 0.5,
            px: 1,
            py: 0.2,
            bgcolor: '#eceaf1',
            borderRadius: `${c.radius.md}px`,
            border: `1px solid ${CHROME_BORDER}`,
          }}
        >
          {isSearch ? (
            <SearchIcon sx={{ fontSize: 13, color: CHROME_TEXT_MUTED, flexShrink: 0 }} />
          ) : isSecure ? (
            <LockIcon sx={{ fontSize: 12, color: c.status.success, flexShrink: 0 }} />
          ) : null}
          <InputBase
            value={urlBarValue}
            onChange={(e) => setUrlBarValue(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            placeholder="Search Google or enter URL..."
            sx={{
              flex: 1,
              fontSize: '0.75rem',
              fontFamily: c.font.mono,
              color: CHROME_TEXT,
              py: 0,
              '& input': { py: '2px', textAlign: 'center' },
              '& input::placeholder': { color: CHROME_TEXT_MUTED, opacity: 1 },
            }}
          />
        </Box>
      </Box>

      {/* Browser body: stacked webviews */}
      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Loading bar is an ABSOLUTE overlay, not an in-flow element: a busy page (Zillow's map fires did-start/stop-loading many times a sec for tiles/ads/XHRs) toggled this on/off, and an in-flow 2px bar shoved the webview down/up each time = visible up/down jitter. As an overlay it never moves layout. */}
        {(activeLocal.loading || (agentActive && agentAction === 'navigate')) && (
          <LinearProgress
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 4,
              height: 2,
              bgcolor: 'transparent',
              '& .MuiLinearProgress-bar': {
                bgcolor: agentActive ? accentColor : c.accent.primary,
              },
            }}
          />
        )}
        {findOpen && !suspendedSnap && (
          <BrowserFindBar browserId={browserId} focusSignal={findFocusSignal} onClose={() => setFindOpen(false)} />
        )}
        {isElementSelectMode && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }} />
        )}
        {cmdHeld && !isSelected && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 12, pointerEvents: 'none' }} />
        )}
        {isElectron ? (
          suspendedSnap ? (
            suspendedSnap.dataUrl ? (
              <Box
                component="img"
                src={suspendedSnap.dataUrl}
                alt=""
                onClick={() => dispatch(resumeBrowserCard(browserId))}
                sx={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'top left',
                  cursor: 'pointer',
                }}
              />
            ) : (
              <Box
                onClick={() => dispatch(resumeBrowserCard(browserId))}
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  bgcolor: c.bg.surface,
                }}
              >
                <Typography sx={{ color: c.text.ghost, fontSize: '0.875rem', px: 2, textAlign: 'center' }}>
                  {activeTitle || activeUrl}
                </Typography>
              </Box>
            )
          ) : (
          <>
            {(attachSlotReady ? tabs : []).map((tab) => (
              <webview
                key={tab.id}
                ref={(el: any) => {
                  if (el) webviewMap.current.set(tab.id, el as unknown as WebviewElement);
                  else webviewMap.current.delete(tab.id);
                }}
                data-tab-id={tab.id}
                partition={BROWSER_PARTITION}
                src="about:blank"
                {...({ allowpopups: 'true' } as any) /* React drops boolean-valued unknown attrs, so string it stays; @types/react wrongly says boolean */}
                useragent={chromeUserAgent}
                {...(webviewPreloadPath ? { preload: webviewPreloadPath } : {})}
                webpreferences="plugins=yes, autoplayPolicy=no-user-gesture-required, backgroundThrottling=no" /* throttling: guests get occlusion-suspended on their own even with the host's disable-renderer-backgrounding, freezing agent JS when the window is covered */
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  visibility: tab.id === activeTabId ? 'visible' : 'hidden',
                  zIndex: tab.id === activeTabId ? 1 : 0,
                  // Only during select mode does the page go click-through, so the element picker can grab the whole card from anywhere instead of just the header (a live webview swallows host clicks). Off select mode = live for browsing.
                  pointerEvents: isElementSelectMode ? 'none' : 'auto',
                }}
              />
            ))}
            <Fade in={!!endingState && !crashedTabs.has(activeTabId)} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 5,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1.25,
                  bgcolor: c.bg.surface,
                }}
              >
                <Typography sx={{ color: c.text.primary, fontSize: '1rem', fontWeight: 500 }}>
                  {endingState?.status === 'error' ? 'Task ended with an error.' : 'Task done.'}
                </Typography>
                <Button
                  onClick={() => dispatch(cancelBrowserCardEnding(browserId))}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    bgcolor: c.accent.primary,
                    color: '#fff',
                    borderRadius: `${c.radius.md}px`,
                    px: 2.25,
                    py: 0.6,
                    '&:hover': { bgcolor: c.accent.hover || c.accent.primary },
                  }}
                >
                  Keep
                </Button>
              </Box>
            </Fade>
            <Fade in={crashedTabs.has(activeTabId)} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1.25,
                  bgcolor: c.bg.surface,
                }}
              >
                <Typography sx={{ color: c.text.primary, fontSize: '1rem', fontWeight: 500 }}>
                  This page stopped responding.
                </Typography>
                <Button
                  onClick={() => webviewMap.current.get(activeTabId)?.reload()}
                  startIcon={<RefreshIcon sx={{ fontSize: '1rem' }} />}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    bgcolor: c.accent.primary,
                    color: '#fff',
                    borderRadius: `${c.radius.md}px`,
                    px: 2.25,
                    py: 0.6,
                    '&:hover': { bgcolor: c.accent.hover || c.accent.primary },
                  }}
                >
                  Reload
                </Button>
              </Box>
            </Fade>
          </>
          )
        ) : null}
        <Dialog
          open={passkeyDialogOpen}
          onClose={() => setPasskeyDialogOpen(false)}
          PaperProps={{
            sx: {
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: `${c.radius.lg}px`,
              maxWidth: 420,
            },
          }}
        >
          <DialogTitle sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary, pb: 1 }}>
            Passkeys aren't supported
          </DialogTitle>
          <DialogContent sx={{ pb: 1 }}>
            <Typography sx={{ fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.5 }}>
              Sorry, OpenSwarm doesn't support passkeys. Please sign in with a password or another method.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button
              onClick={() => setPasskeyDialogOpen(false)}
              sx={{
                textTransform: 'none',
                fontSize: '0.8125rem',
                fontWeight: 600,
                bgcolor: c.accent.primary,
                color: '#fff',
                borderRadius: `${c.radius.md}px`,
                px: 2.25,
                py: 0.6,
                '&:hover': { bgcolor: c.accent.hover || c.accent.primary },
              }}
            >
              OK
            </Button>
          </DialogActions>
        </Dialog>
        {!isElectron && (inElectron ? (
          // inElectron but !isElectron = Windows after the webview crashed (windowsWebviewEnabled() false); keep the iframe as the crash safety net. No sandbox so sites render; the renderer's already isolated by Electron + the main.js XFO/CSP strip.
          <Box sx={{ width: '100%', height: '100%', position: 'relative' }}>
            <iframe
              src={activeUrl}
              style={{ width: '100%', height: '100%', border: 'none', pointerEvents: isElementSelectMode ? 'none' : 'auto' }}
              title="Browser"
              referrerPolicy="no-referrer-when-downgrade"
              onError={(e) => {
                // eslint-disable-next-line no-console
                console.error('[diag][iframe:onError]', activeUrl, (e as any)?.message || e);
              }}
            />
          </Box>
        ) : (
          <RunInDesktopMessage kind="browser" />
        ))}

        {/* Camera flash: screenshot */}
        {(agentAction === 'screenshot' || lastAction === 'screenshot') && (
          <Box
            key={`flash-${activity.actionSeq}`}
            sx={{
              position: 'absolute',
              inset: 0,
              bgcolor: '#fff',
              pointerEvents: 'none',
              zIndex: 15,
              animation: 'camera-flash 0.4s ease-out forwards',
              '@keyframes camera-flash': {
                '0%': { opacity: 0.45 },
                '100%': { opacity: 0 },
              },
            }}
          />
        )}

        {/* Scanning line: get_text */}
        {agentAction === 'get_text' && (
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: '3px',
              zIndex: 15,
              pointerEvents: 'none',
              background: `linear-gradient(180deg, transparent, ${accentColor}90, transparent)`,
              boxShadow: `0 0 12px ${accentColor}60`,
              animation: 'scan-sweep 1.5s ease-in-out infinite alternate',
              '@keyframes scan-sweep': {
                '0%': { top: '0%' },
                '100%': { top: 'calc(100% - 3px)' },
              },
            }}
          />
        )}

        {/* Click ripple */}
        {(agentAction === 'click' || lastAction === 'click') && (
          <Box
            key={`ripple-${activity.actionSeq}`}
            sx={{
              position: 'absolute',
              top: `${(activity.coords?.yPercent ?? 0.5) * 100}%`,
              left: `${(activity.coords?.xPercent ?? 0.5) * 100}%`,
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: `2px solid ${accentColor}`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 15,
              animation: 'click-ripple 0.5s ease-out forwards',
              '@keyframes click-ripple': {
                '0%': { opacity: 0.8, width: 10, height: 10, borderWidth: '2px' },
                '100%': { opacity: 0, width: 60, height: 60, borderWidth: '1px' },
              },
            }}
          />
        )}

        {/* Typing indicator */}
        {agentAction === 'type' && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              gap: '4px',
              alignItems: 'center',
              px: 1,
              py: 0.5,
              borderRadius: '8px',
              bgcolor: `${accentColor}20`,
              border: `1px solid ${accentColor}40`,
              zIndex: 15,
              pointerEvents: 'none',
            }}
          >
            {[0, 1, 2].map((i) => (
              <Box
                key={i}
                sx={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  bgcolor: accentColor,
                  animation: `typing-dot 1s ease-in-out ${i * 0.15}s infinite`,
                  '@keyframes typing-dot': {
                    '0%, 60%, 100%': { opacity: 0.3, transform: 'scale(0.8)' },
                    '30%': { opacity: 1, transform: 'scale(1.2)' },
                  },
                }}
              />
            ))}
          </Box>
        )}

        {/* ===== Frosted glass overlay ===== */}
        {agentActive && !browserAgentSession && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 16,
              backdropFilter: 'blur(2px)',
              bgcolor: 'rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              animation: 'overlay-fade-in 0.25s ease-out',
              '@keyframes overlay-fade-in': {
                '0%': { opacity: 0 },
                '100%': { opacity: 1 },
              },
            }}
          >
            <CircularProgress
              size={28}
              thickness={3}
              sx={{ color: accentColor }}
            />
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.5,
                py: 0.75,
                borderRadius: '10px',
                bgcolor: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(8px)',
                border: `1px solid ${accentColor}30`,
              }}
            >
              <SmartToyOutlinedIcon sx={{ fontSize: 14, color: accentColor }} />
              <Typography
                sx={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#fff',
                  letterSpacing: '0.02em',
                }}
              >
                {getActionLabel(agentAction ?? '')}
              </Typography>
            </Box>
          </Box>
        )}

        {/* ===== Browser Agent Overlay ===== */}
        {browserAgentSession && (
          <BrowserAgentOverlay
            session={browserAgentSession}
            browserWidth={displayW}
            browserHeight={displayH}
          />
        )}
      </Box>

      {/* Resize handles; a docked mini's size follows the slot, so grabbing an edge used to pop it out of the chat mid-gesture. */}
      {!dockActive && RESIZE_HANDLE_DEFS.map(({ dir, css }) => (
        <Box
          key={dir}
          className="resize-handle"
          onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          sx={{
            position: 'absolute',
            cursor: RESIZE_CURSOR[dir],
            opacity: 0,
            zIndex: 20,
            ...css,
          }}
        />
      ))}

      {/* Detached-tab ghost: fixed-position pill under the cursor while a tab is dragged out of the strip. pointerEvents none so the drop hit-test sees the cards underneath it. */}
      {detachGhost && dragTabId && createPortal(
        (() => {
          const ghostTab = tabs.find((t) => t.id === dragTabId);
          return (
            <Box
              sx={{
                position: 'fixed',
                left: detachGhost.x + 10,
                top: detachGhost.y + 10,
                zIndex: 2147483647,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.25,
                py: 0.5,
                maxWidth: 240,
                bgcolor: c.bg.elevated,
                border: `1px solid ${c.border.medium}`,
                borderRadius: `${c.radius.md}px`,
                boxShadow: c.shadow.lg,
              }}
            >
              {ghostTab?.favicon ? (
                <Box component="img" src={ghostTab.favicon} sx={{ width: 14, height: 14, flexShrink: 0 }} />
              ) : (
                <LanguageIcon sx={{ fontSize: 14, color: c.text.muted, flexShrink: 0 }} />
              )}
              <Typography sx={{ fontSize: '0.75rem', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ghostTab?.title || ghostTab?.url || 'Tab'}
              </Typography>
            </Box>
          );
        })(),
        document.body,
      )}

    </Box>
  );
};

export default React.memo(BrowserCard);
