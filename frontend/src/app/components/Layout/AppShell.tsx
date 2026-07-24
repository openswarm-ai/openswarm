import React, { useState, useEffect, useRef, useCallback, startTransition, useMemo } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import { getLastInteractedBrowser, getKeepAliveBrowserIds, setLastInteractedBrowser, clearLastInteractedBrowser } from '@/shared/browserFocus';
import { getWebview } from '@/shared/browserRegistry';
import { applyBrowserZoom } from '@/shared/browserZoom';
import Box from '@mui/material/Box';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { VoiceDictationProvider } from '@/shared/voice/VoiceDictationContext';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import InputBase from '@mui/material/InputBase';
// One outlined icon language for the sidebar: thin monoline glyphs (not the filled Material clip-art) so the rail reads as designed, not assembled.
import { LayoutDashboard } from 'lucide-react';
import { LayoutGrid } from 'lucide-react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Settings as LucideSettings } from 'lucide-react';
import { ArrowLeft, ArrowRight, Plus, Clock, Search as SearchGlyph, X as CloseGlyph } from 'lucide-react';
import ButtonBase from '@mui/material/ButtonBase';
import { AnimatedPanelLeft } from './animatedIcons';

const SEARCH_HOTKEY_LABEL = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
// Settings modal lazy-loaded so its 2.3K LOC + Stripe/OAuth helpers don't ship on first paint.
const Settings = React.lazy(() => import('@/app/pages/Settings/Settings'));
import DynamicIsland from '@/app/components/overlays/DynamicIsland';
import Dashboard from '@/app/pages/Dashboard/Dashboard';
import DashboardHost from '@/app/components/Layout/DashboardHost';
import { useLastDashboardId } from '@/shared/hooks/useLastDashboardId';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { hasModelConnected as selectHasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { shallowEqual } from 'react-redux';
import { fetchDashboards, createDashboard, renameDashboard, deleteDashboard, duplicateDashboard } from '@/shared/state/dashboardsSlice';
import { Typewriter } from '@/app/components/feedback/Animated';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { addBrowserCard, addBrowserTab, cycleBrowserTab, reopenLastClosed, addViewCard, selectFullscreenCardId, setTiledCard, clearTiledCard } from '@/shared/state/dashboardLayoutSlice';
import { setPendingBrowserUrl } from '@/shared/state/tempStateSlice';
import { fetchOutputs, deleteOutput, updateOutput } from '@/shared/state/outputsSlice';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import { setInstalling } from '@/shared/state/updateSlice';
import { findBrowserByWebContentsId } from '@/shared/browserRegistry';
import { byPreviewRecency } from '@/shared/previewOrder';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 400;
// 260 matches Claude.ai's nav-sidebar width: roomy enough that names don't truncate.
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_WIDTH_KEY = 'openswarm-sidebar-width';
const UPDATE_DISMISS_KEY = 'openswarm-update-dismissed';

const AppShell: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigateRaw = useNavigate();
  // startTransition wrapper: route swap becomes non-urgent so click handler returns immediately; eliminates the "click, wait, page appears" gap on slow routes.
  const navigate = useMemo(() => {
    const fn = (...args: Parameters<typeof navigateRaw>) => {
      startTransition(() => {
        (navigateRaw as any)(...args);
      });
    };
    return fn as typeof navigateRaw;
  }, [navigateRaw]);
  const location = useLocation();
  // React Router (HashRouter) stores a monotonic index in history state. location re-renders on every nav, by which point window.history.state.idx is updated.
  const historyIdx = (window.history.state?.idx as number | undefined) ?? 0;
  const maxHistoryIdx = useRef(0);
  maxHistoryIdx.current = Math.max(maxHistoryIdx.current, historyIdx);
  const canGoBack = historyIdx > 0;
  const canGoForward = historyIdx < maxHistoryIdx.current;
  const [dashboardsExpanded, setDashboardsExpanded] = useState(true);
  const [appsExpanded, setAppsExpanded] = useState(true);
  // Desktop shell: the wallpaper canvas IS the home surface, so the sidebar starts docked away
  // (left-edge hover peeks it; the pin toggle brings it back full-time).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [renamingDashboardId, setRenamingDashboardId] = useState<string | null>(null);
  const [renamingAppId, setRenamingAppId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Arc-style delete: the row vanishes at once but the real delete waits behind an Undo toast.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ top: number; left: number; kind: 'dashboard' | 'app'; id: string; name: string } | null>(null);
  const pendingDeleteRef = useRef<{ id: string; name: string } | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Arc-style peek: hovering an app row (with intent, not a fly-by) floats a preview beside the sidebar.
  const [peek, setPeek] = useState<{ name: string; description: string; thumbnail: string | null; top: number } | null>(null);
  const peekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Arc-style Space switching: a horizontal two-finger swipe over the sidebar flips dashboards. Kept OFF
  // the canvas (which owns horizontal pan) so the two never fight. accum + cooldown = one flip per swipe.
  const swipeAccumRef = useRef(0);
  const swipeCooldownRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (stored) {
        const w = Number(stored);
        if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) return w;
      }
    } catch {}
    return SIDEBAR_DEFAULT;
  });
  const isResizing = useRef(false);

  const updateStatus = useAppSelector((state) => state.update.status);
  const availableVersion = useAppSelector((state) => state.update.availableVersion);
  const downloadPercent = useAppSelector((state) => state.update.downloadPercent);
  const installing = useAppSelector((state) => state.update.installing);
  // Windows' Squirrel never reports a version, and a mid-download cache-clear reload wipes it, so render the name version-less instead of "OpenSwarm null".
  const verSuffix = availableVersion ? ` ${availableVersion}` : '';

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try { return localStorage.getItem(UPDATE_DISMISS_KEY); } catch { return null; }
  });
  const [snackbarDismissed, setSnackbarDismissed] = useState(false);

  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const modelsLoaded = useAppSelector((s) => s.models.loaded);
  // "Connected" = the user's OWN model (key/sub/pro/custom), NOT a non-empty /models list: the free-trial Haiku is always in that list now, so a byProvider-length check would falsely read as connected and hide the out-of-runs banner.
  const hasModelConnected = useAppSelector(selectHasModelConnected);
  // During an active free trial the user CAN run things, so a red "no model connected" warning is misleading and discouraging (it sits right above the working starter chips). The trial flips connection_mode back to own_key the moment it's spent, so this banner returns then, landing the connect-a-model nudge after the win, not before it.
  const freeTrialActive = useAppSelector((s) => {
    const d = s.settings.data as any;
    return !!(d && d.connection_mode === 'free-trial' && d.free_trial_token);
  });
  // Trial just ran dry (had an allotment, now 0, off the free lane): a quiet connect nudge, not the red error wall. Runs refill, so it's "for now".
  const freeTrialSpent = useAppSelector((s) => {
    const d = s.settings.data as any;
    return !!(d && (d.free_trial_runs_limit ?? 0) > 0 && d.free_trial_remaining === 0 && d.connection_mode !== 'free-trial');
  });
  // Post-wow: on the free lane and already got value (spent >= 1 run); offer the unlimited path they likely already own while they're happy, not when they're blocked.
  const freeTrialUsed = useAppSelector((s) => {
    const d = s.settings.data as any;
    if (!d || d.connection_mode !== 'free-trial' || !d.free_trial_token) return false;
    const limit = d.free_trial_runs_limit ?? 0;
    const remaining = d.free_trial_remaining ?? limit;
    return limit > 0 && (limit - remaining) >= 1;
  });
  const freeTrialResetsAt = useAppSelector((s) => (s.settings.data as any)?.free_trial_resets_at ?? null);
  // Coarse "~3h" / "~20m" label for when the rolling window refills; null when unknown or basically now. Static (not a ticking countdown) on purpose: a per-second timer is needless churn for a 5h window.
  const refillLabel = React.useMemo(() => {
    if (!freeTrialResetsAt) return null;
    const secs = freeTrialResetsAt - Date.now() / 1000;
    if (secs <= 90) return null;
    const h = Math.floor(secs / 3600);
    if (h >= 1) return `~${h}h`;
    return `~${Math.max(1, Math.round(secs / 60))}m`;
  }, [freeTrialResetsAt]);

  // Paid (openswarm-pro) usage meter: same calm "you're near/at the cap, here's when it's back" pattern as the free-trial nudge, but the bar IS the message. Only fires in pro mode on real server-owned usage (requests_in_window/plan_limit), and only once near the cap, so it never clutters the normal flow. window_ends_at is unix MS (the trial's resets_at is seconds).
  const proUsage = useAppSelector((s) => {
    const d = s.settings.data as any;
    if (!d || d.connection_mode !== 'openswarm-pro') return null;
    const u = d.openswarm_usage_cached;
    return u && u.plan_limit > 0 ? u : null;
  }, shallowEqual);
  const proPct = proUsage ? Math.min(1, proUsage.requests_in_window / proUsage.plan_limit) : 0;
  const proMaxed = !!proUsage && proPct >= 1;
  const showUsageNudge = isOnline && !!proUsage && proPct >= 0.8;
  const usageResetLabel = React.useMemo(() => {
    const endsAt = proUsage?.window_ends_at ?? 0;
    if (!endsAt) return null;
    const secs = (endsAt - Date.now()) / 1000;
    if (secs <= 90) return null;
    const h = Math.floor(secs / 3600);
    return h >= 1 ? `~${h}h` : `~${Math.max(1, Math.round(secs / 60))}m`;
  }, [proUsage]);
  // Hold the banner until the boot free-trial mint settles, else a brand-new user sees it flash red for the ~1-3s the trial takes to arm. (Offline shows immediately, it's its own signal.)
  const freeTrialArmSettled = useAppSelector((s) => s.settings.freeTrialArmSettled);
  // The red wall is for genuine "no way to run" only; the free-trial states get the quiet nudge below.
  const showWarningBanner = !isOnline || (modelsLoaded && freeTrialArmSettled && !hasModelConnected && !freeTrialActive && !freeTrialSpent);
  const [ftNudgeDismissed, setFtNudgeDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem('os_ft_nudge_dismissed') === '1'; } catch { return false; }
  });
  // Spent nudge hides the moment they connect a real model; the post-wow nudge only shows on the trial lane (so it already implies no own model) and is dismissible.
  const showFreeTrialNudge = isOnline && ((freeTrialSpent && !hasModelConnected) || (freeTrialUsed && !ftNudgeDismissed));

  const bannerDismissedForVersion = availableVersion != null && dismissedVersion === availableVersion;
  const isUpdateActionable = updateStatus === 'available' || updateStatus === 'downloaded' || updateStatus === 'downloading';

  const showUpdateDot = (updateStatus === 'available' || updateStatus === 'downloaded') && !bannerDismissedForVersion;
  const showUpdateBanner = isUpdateActionable && !bannerDismissedForVersion;
  const showUpdateSnackbar = (updateStatus === 'available' || updateStatus === 'downloaded') && !bannerDismissedForVersion && !snackbarDismissed;

  const handleDismissBanner = useCallback(() => {
    if (availableVersion) {
      try { localStorage.setItem(UPDATE_DISMISS_KEY, availableVersion); } catch {}
      setDismissedVersion(availableVersion);
    }
  }, [availableVersion]);

  const handleDownloadUpdate = useCallback(async () => {
    try { await (window as any).openswarm?.downloadUpdate(); } catch {}
  }, []);

  const handleInstallUpdate = useCallback(() => {
    if (installing) return;
    dispatch(setInstalling());
    (window as any).openswarm?.installUpdate();
  }, [installing, dispatch]);

  // shallowEqual on top-level Immer dicts: nested mutations bump the dict reference, causing AppShell to re-render on every rename/output bump despite identical structure.
  const dashboardItems = useAppSelector(
    (state) => state.dashboards.items,
    shallowEqual,
  );
  const dashboardList = React.useMemo(
    () => Object.values(dashboardItems).sort(byPreviewRecency),
    [dashboardItems],
  );

  const outputItems = useAppSelector(
    (state) => state.outputs.items,
    shallowEqual,
  );
  const appsList = React.useMemo(
    () => Object.values(outputItems).sort(byPreviewRecency),
    [outputItems],
  );

  useEffect(() => {
    dispatch(fetchDashboards());
    dispatch(fetchOutputs());
  }, [dispatch]);

  // Idle-prefetch the lazy Settings chunk so click-to-open is instant; requestIdleCallback avoids fighting first-paint.
  useEffect(() => {
    const ric = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1500));
    const handle = ric(() => {
      import('@/app/pages/Settings/Settings').catch(() => {});
    }, { timeout: 3000 });
    return () => {
      const cic = (window as any).cancelIdleCallback || clearTimeout;
      try { cic(handle); } catch {}
    };
  }, []);

  const openUrlInBrowser = useCallback((url: string, webContentsId?: number, background?: boolean) => {
    const dashMatch = location.pathname.match(/^\/dashboard\/(.+)/);
    if (dashMatch) {
      if (webContentsId != null) {
        const browserId = findBrowserByWebContentsId(webContentsId);
        if (browserId) {
          // Middle-click / background-tab disposition: add the tab but don't steal focus from the current one, like a real browser.
          dispatch(addBrowserTab({ browserId, url, makeActive: !background }));
          return;
        }
      }
      dispatch(addBrowserCard({ url }));
    } else {
      dispatch(setPendingBrowserUrl(url));
      const lastId = (window as any).__openswarm_last_dashboard_id as string | undefined;
      const firstDashboard = dashboardList[0];
      // Only navigate to lastId if it's a REAL dashboard: a stale localStorage id for a deleted dashboard used to route to /dashboard/<phantom>, which 404s and re-fires the layout wipe (drops your cards / breaks a drag).
      const lastIsReal = !!lastId && dashboardList.some((d) => d.id === lastId);
      const targetId = (lastIsReal ? lastId : undefined) || firstDashboard?.id;
      if (targetId) {
        navigate(`/dashboard/${targetId}`);
      } else {
        dispatch(createDashboard('Untitled Dashboard')).then((result: any) => {
          if (createDashboard.fulfilled.match(result)) {
            navigate(`/dashboard/${result.payload.id}`);
          }
        });
      }
    }
  }, [location.pathname, dashboardList, dispatch, navigate]);

  useEffect(() => {
    let lastUrl = '';
    let lastTime = 0;

    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      if (href.startsWith('http://localhost:')) return;

      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      if (href === lastUrl && now - lastTime < 1000) return;
      lastUrl = href;
      lastTime = now;

      openUrlInBrowser(href);
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [openUrlInBrowser]);

  useEffect(() => {
    const w = window as any;
    if (!w.openswarm?.onWebviewNewWindow) return;
    let lastUrl = '';
    let lastTime = 0;
    return w.openswarm.onWebviewNewWindow((url: string, webContentsId: number, disposition?: string) => {
      const now = Date.now();
      if (url === lastUrl && now - lastTime < 1000) return;
      lastUrl = url;
      lastTime = now;
      openUrlInBrowser(url, webContentsId, disposition === 'background-tab');
    });
  }, [openUrlInBrowser]);

  // Track the browser card the user last touched. Chrome clicks land on this document; a webview PAGE click can't reach it, so BrowserCard reports those via the app-clicked IPC. Clearing on any non-browser-card click is what makes Ctrl+R fall back to reloading the app.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const card = (e.target as HTMLElement | null)?.closest?.('[data-select-type="browser-card"]') as HTMLElement | null;
      if (card) setLastInteractedBrowser(card.getAttribute('data-select-id') || '');
      else clearLastInteractedBrowser();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // Cmd/Ctrl+R: main neutralizes the default-menu reload and hands us the decision. Reload the browser you're in or last used IN PLACE (keeps its login); only when no browser is open at all fall back to a full app reload, since reloading the renderer destroys every webview and wipes its session. To deliberately reload OpenSwarm itself, use View > Reload.
  useEffect(() => {
    const w = window as any;
    if (!w.openswarm?.onReloadShortcut) return;
    return w.openswarm.onReloadShortcut(() => {
      for (const id of [getLastInteractedBrowser(), ...getKeepAliveBrowserIds()]) {
        const wv = id ? getWebview(id) : undefined;
        if (wv) { try { wv.reload(); return; } catch (_e) { /* torn-down webview; try the next */ } }
      }
      window.location.reload();
    });
  }, []);

  // Zoom / find / tab-cycle from a focused browser GUEST (keydowns inside a webview can't reach this document, so main forwards them with the guest's id). Targets that exact browser; the host-focused counterparts live in the keydown below + useCanvasControls (zoom).
  useEffect(() => {
    const w = window as any;
    if (!w.openswarm?.onBrowserShortcut) return;
    return w.openswarm.onBrowserShortcut((payload: { action: string; webContentsId: number }) => {
      // Reopen-last-closed is global (no target browser), so handle it before the per-browser id guard.
      if (payload.action === 'reopen-closed') { dispatch(reopenLastClosed()); return; }
      const id = findBrowserByWebContentsId(payload.webContentsId) ?? getLastInteractedBrowser();
      if (!id) return;
      switch (payload.action) {
        case 'zoom-in': applyBrowserZoom(id, 1); break;
        case 'zoom-out': applyBrowserZoom(id, -1); break;
        case 'zoom-reset': applyBrowserZoom(id, 0); break;
        case 'find': window.dispatchEvent(new CustomEvent('openswarm:browser-find', { detail: { browserId: id } })); break;
        case 'tab-next': dispatch(cycleBrowserTab({ browserId: id, dir: 1 })); break;
        case 'tab-prev': dispatch(cycleBrowserTab({ browserId: id, dir: -1 })); break;
      }
    });
  }, [dispatch]);

  // Host-focused Ctrl/Cmd+F (find) and Ctrl+Tab (cycle) when a browser is the last thing you touched. Zoom keys aren't here: they share the +/-/0 keys with canvas zoom, so useCanvasControls owns that branch.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const id = getLastInteractedBrowser();
      // Require a LIVE webview: a stale id (its card was closed) means no browser is focused, so let the canvas shortcuts (e.g. card-search Cmd+F) handle the key instead.
      if (!id || !getWebview(id)) return;
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || !!t?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key || '').toLowerCase() === 'f' && !typing) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('openswarm:browser-find', { detail: { browserId: id } }));
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        dispatch(cycleBrowserTab({ browserId: id, dir: e.shiftKey ? -1 : 1 }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch]);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const { sessionId, dashboardId } = detail as { sessionId?: string; dashboardId?: string };
      if (!sessionId) return;
      if (dashboardId) {
        navigate(`/dashboard/${dashboardId}`);
      }
      dispatch(setPendingFocusAgentId(sessionId));
    };
    window.addEventListener('openswarm:notification-click', handler as EventListener);
    return () => window.removeEventListener('openswarm:notification-click', handler as EventListener);
  }, [navigate, dispatch]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)));
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleResizeDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
  }, []);

  const isDashboardRoute = location.pathname === '/' || location.pathname.startsWith('/dashboard/');
  const isDashboardViewActive = location.pathname.startsWith('/dashboard/');
  // macOS full screen: a fullscreen-tiled card owns the window, so every shell chrome piece hides. Gated on the dashboard view so navigating away restores the chrome even mid-fullscreen.
  const fullscreenCardId = useAppSelector(selectFullscreenCardId);
  // Zen compact mode: the sidebar is the only chrome now, so whenever it's "away" (user collapsed it,
  // OR a fullscreen card hides everything) a left-edge hover floats it back in as an overlay.
  const fsActive = !!fullscreenCardId && isDashboardViewActive;
  // Arc: the sidebar toggle PINS the sidebar open inside fullscreen (docked, card shrinks beside it);
  // unpinned fullscreen keeps the hover-peek overlay.
  const [fsSidebarPinned, setFsSidebarPinned] = useState(false);
  const sidebarAway = (sidebarCollapsed || (fsActive && !fsSidebarPinned)) && isDashboardViewActive;
  const [sidePeek, setSidePeek] = useState(false);
  useEffect(() => { if (!sidebarAway) setSidePeek(false); }, [sidebarAway]);
  // When the sidebar docks away, the canvas runs flush to the window's left edge, so the floating
  // dashboard header would sit right under the macOS traffic lights. Publish an inset the header reads
  // (only on macOS, where the lights exist) so it clears them; the sidebar carries its own clearance.
  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    const root = document.documentElement;
    if (sidebarAway && isMac) root.style.setProperty('--osw-header-inset', '80px');
    else root.style.removeProperty('--osw-header-inset');
    return () => { root.style.removeProperty('--osw-header-inset'); };
  }, [sidebarAway]);
  // Global text-size ratio (Settings > Interface). Scaling the root font-size scales every rem-based
  // size in one shot, so type grows or shrinks together with no layout breakage. Clamped to a sane band
  // so a corrupt value can never wreck the whole UI.
  const uiFontScale = useAppSelector((s) => s.settings.data.ui_font_scale ?? 1);
  useEffect(() => {
    const clamped = Math.min(1.4, Math.max(0.8, uiFontScale || 1));
    document.documentElement.style.fontSize = `${Math.round(clamped * 100)}%`;
  }, [uiFontScale]);
  // When the sidebar is docked, the macOS traffic lights sit over its top strip, which is a window
  // drag region that swallows mousemove, so the canvas hover-reveal can never fire there. Broadcast
  // "chrome docked" so the canvas keeps the native lights visible while the sidebar is open (they only
  // hide-until-hover in the immersive collapsed/fullscreen state). detail.docked = sidebar is present.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('openswarm:chrome-docked', { detail: { docked: !sidebarAway } }));
  }, [sidebarAway]);
  // Close-on-leave with a grace delay (cancelled on re-enter): a bare mouseLeave closed the peek the
  // instant the cursor dipped past the panel edge while reaching for an item, so clicks never landed.
  const peekCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPeekClose = useCallback(() => {
    if (peekCloseTimerRef.current) { clearTimeout(peekCloseTimerRef.current); peekCloseTimerRef.current = null; }
  }, []);
  const schedulePeekClose = useCallback(() => {
    cancelPeekClose();
    peekCloseTimerRef.current = setTimeout(() => setSidePeek(false), 260);
  }, [cancelPeekClose]);
  // Reliable window-level close: the panel's own mouseLeave can get eaten (webview/overlay capture),
  // leaving the peek stuck open. This fires on every move and closes ONLY when the cursor is clearly
  // to the right of the floating panel (generous 130px buffer so reaching for an item never closes it).
  useEffect(() => {
    if (!sidePeek) return undefined;
    const onMove = (e: MouseEvent): void => {
      if (e.clientX > 10 + sidebarWidth + 130) schedulePeekClose();
      else cancelPeekClose();
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [sidePeek, sidebarWidth, schedulePeekClose, cancelPeekClose]);
  // Fullscreen still hides the top-center island anchor + banners; the sidebar floats in on peek.
  const fsHideChrome = fsActive;
  // In overlay mode the panel stays MOUNTED (so it can slide out, not vanish); sidePeek only drives the slide.
  const sideOverlay = sidebarAway;
  const isAppsRoute = false;  // /apps route removed; app cards live on the dashboard now.
  const activeDashboardId = location.pathname.startsWith('/dashboard/')
    ? location.pathname.split('/dashboard/')[1]
    : null;

  // Flip to the previous/next dashboard, clamped at the ends (no surprise wrap). Shared by the sidebar
  // swipe and the Cmd/Ctrl+Alt+arrow keyboard path.
  const switchDashboard = useCallback((dir: -1 | 1) => {
    if (dashboardList.length < 2) return;
    const idx = dashboardList.findIndex((d) => d.id === activeDashboardId);
    if (idx < 0) return;
    const next = Math.min(dashboardList.length - 1, Math.max(0, idx + dir));
    if (next !== idx) navigate(`/dashboard/${dashboardList[next].id}`);
  }, [dashboardList, activeDashboardId, navigate]);

  const handleSidebarSwipe = useCallback((e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) { swipeAccumRef.current = 0; return; }  // vertical = list scroll
    if (swipeCooldownRef.current) return;
    swipeAccumRef.current += e.deltaX;
    if (Math.abs(swipeAccumRef.current) >= 80) {
      switchDashboard(swipeAccumRef.current > 0 ? 1 : -1);
      swipeAccumRef.current = 0;
      swipeCooldownRef.current = true;
      setTimeout(() => { swipeCooldownRef.current = false; }, 450);
    }
  }, [switchDashboard]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); switchDashboard(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); switchDashboard(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [switchDashboard]);

  const [lastDashboardId, setLastDashboardId] = useLastDashboardId();
  // Apps no longer have a full-page editor; clicking one in the sidebar drops (or focuses) its live card on the current dashboard. Fold-in of the old App Builder. While a card is fullscreen the click SWAPS the pinned card to this app (Arc: the sidebar switches what fills the screen), otherwise the new card would land invisibly behind it.
  const navigateToApp = useCallback((id: string) => {
    dispatch(addViewCard({ outputId: id }));
    if (fullscreenCardId) {
      if (fullscreenCardId !== id) dispatch(clearTiledCard(fullscreenCardId));
      dispatch(setTiledCard({ cardId: id, zone: 'fullscreen' }));
      return;
    }
    if (lastDashboardId && location.pathname !== `/dashboard/${lastDashboardId}`) {
      navigate(`/dashboard/${lastDashboardId}`);
    }
  }, [dispatch, navigate, lastDashboardId, location.pathname, fullscreenCardId]);
  // The real delete, run only once Undo has lapsed: tear the live view card down cleanly (never rip a
  // webview GPU surface mid-composite), then delete the output for good.
  const commitDeleteApp = useCallback((id: string) => {
    void removeViewCardCleanly(id, dispatch);
    dispatch(deleteOutput(id));
  }, [dispatch]);

  // Arc-style delete: the row hides immediately and an Undo toast holds for 6s. Undo restores it;
  // silence commits it. A second delete flushes the first (only one pending at a time).
  const handleDeleteApp = useCallback((e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    const prev = pendingDeleteRef.current;
    if (prev && prev.id !== id) commitDeleteApp(prev.id);
    const entry = { id, name };
    pendingDeleteRef.current = entry;
    setPendingDelete(entry);
    deleteTimerRef.current = setTimeout(() => {
      commitDeleteApp(id);
      pendingDeleteRef.current = null;
      setPendingDelete(null);
      deleteTimerRef.current = null;
    }, 6000);
  }, [commitDeleteApp]);

  const handleUndoDeleteApp = useCallback(() => {
    if (deleteTimerRef.current) { clearTimeout(deleteTimerRef.current); deleteTimerRef.current = null; }
    pendingDeleteRef.current = null;
    setPendingDelete(null);
  }, []);

  // Leaving the app while a delete is still pending shouldn't strand a half-deleted ghost: commit it.
  useEffect(() => () => {
    if (deleteTimerRef.current) { clearTimeout(deleteTimerRef.current); }
    if (pendingDeleteRef.current) commitDeleteApp(pendingDeleteRef.current.id);
    if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
  }, [commitDeleteApp]);

  const handleStartAppRename = (id: string, currentName: string) => {
    setRenamingDashboardId(null);
    setRenamingAppId(id);
    setRenameValue(currentName);
  };

  const handleAppRenameSubmit = (id: string) => {
    const trimmed = renameValue.trim();
    const previousName = outputItems[id]?.name;
    if (trimmed && trimmed !== previousName) {
      dispatch(updateOutput({ id, name: trimmed }));
    }
    setRenamingAppId(null);
  };
  // With the /apps route gone, an app row is "active" when its card is open on the dashboard, not from the URL.
  const openViewCardOutputIds = useAppSelector((s) =>
    new Set(Object.values(s.dashboardLayout.viewCards).map((vc) => vc.output_id)),
  );

  const handleDashboardsClick = () => {
    if (isDashboardRoute && location.pathname === '/') {
      setDashboardsExpanded((prev) => !prev);
    } else {
      navigate('/');
      setDashboardsExpanded(true);
    }
  };

  const handleDashboardItemClick = (dashboardId: string) => {
    if (renamingDashboardId === dashboardId) return;
    // In fullscreen, clicking the dashboard you are already on means "show me the canvas": exit the
    // pinned view. A different dashboard exits via the resetLayout tile clear on switch.
    if (fullscreenCardId && activeDashboardId === dashboardId) {
      dispatch(clearTiledCard(fullscreenCardId));
      return;
    }
    navigate(`/dashboard/${dashboardId}`);
  };

  const handleStartDashboardRename = (id: string, currentName: string) => {
    setRenamingAppId(null);
    setRenamingDashboardId(id);
    setRenameValue(currentName);
  };

  // Right-click a sidebar row for the same actions the Dashboards grid offers, Mac-style at the cursor.
  const openRowMenu = (e: React.MouseEvent, kind: 'dashboard' | 'app', id: string, name: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setRowMenu({ top: e.clientY, left: e.clientX, kind, id, name });
  };
  const closeRowMenu = (): void => setRowMenu(null);
  const rowMenuRename = (): void => {
    const m = rowMenu;
    closeRowMenu();
    if (!m) return;
    // Defer so the menu's focus trap releases before the inline field autofocuses.
    setTimeout(() => (m.kind === 'dashboard' ? handleStartDashboardRename(m.id, m.name) : handleStartAppRename(m.id, m.name)), 150);
  };
  const rowMenuDelete = (e: React.MouseEvent): void => {
    const m = rowMenu;
    closeRowMenu();
    if (!m) return;
    if (m.kind === 'dashboard') dispatch(deleteDashboard(m.id));
    else handleDeleteApp(e, m.id, m.name);
  };
  const rowMenuDuplicate = (): void => {
    const m = rowMenu;
    closeRowMenu();
    if (m?.kind === 'dashboard') dispatch(duplicateDashboard(m.id));
  };

  const handleDashboardRenameSubmit = (id: string) => {
    const trimmed = renameValue.trim();
    const previousName = dashboardItems[id]?.name;
    if (trimmed && trimmed !== previousName) {
      dispatch(renameDashboard({ id, name: trimmed, previousName }));
    }
    setRenamingDashboardId(null);
  };

  const handleCreateDashboard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await dispatch(createDashboard('Untitled Dashboard'));
    if (createDashboard.fulfilled.match(result)) {
      navigate(`/dashboard/${result.payload.id}`);
    }
  };

  const handleAppsClick = () => {
    setAppsExpanded((prev) => !prev);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: c.bg.secondary }}>
      {sidebarAway && !sidePeek && (
        <Box onMouseEnter={() => { cancelPeekClose(); setSidePeek(true); }} sx={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 14, zIndex: 2147483000, pointerEvents: 'auto' }} />
      )}
      {/* Top bar dropped (Arc/Zen): a zero-height anchor left only to float the agent-activity island at top-center; the island renders nothing when idle. */}
      <Box
        sx={{
          height: 0,
          flexShrink: 0,
          position: 'relative',
          overflow: 'visible',
          zIndex: 10,
          display: fsHideChrome ? 'none' : 'block',
        }}
      >
        <DynamicIsland />
      </Box>

      <Collapse in={showWarningBanner && !fsHideChrome} timeout={350} unmountOnExit>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 0.6,
            bgcolor: 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.18)',
            flexShrink: 0,
            animation: showWarningBanner ? 'warning-fade-in 0.4s ease-out' : undefined,
            '@keyframes warning-fade-in': {
              from: { opacity: 0 },
              to: { opacity: 1 },
            },
          }}
        >
          <ErrorSlime size={22} />
          <Typography sx={{ fontSize: '0.875rem', color: '#ef4444', flex: 1, fontWeight: 500, letterSpacing: '0.01em' }}>
            {!isOnline
              ? 'No internet connection; agents cannot reach AI models or external services'
              : (
                <>
                  No AI model connected.{' '}
                  <Box
                    component="span"
                    onClick={() => dispatch(openSettingsModal('models'))}
                    sx={{
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontWeight: 600,
                      '&:hover': { opacity: 0.8 },
                      transition: 'opacity 0.15s',
                    }}
                  >
                    Configure models
                  </Box>
                  {' '}to get started
                </>
              )}
          </Typography>
        </Box>
      </Collapse>

      <Collapse in={showFreeTrialNudge && !fsHideChrome} timeout={300} unmountOnExit>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, flexShrink: 0 }}>
          <Typography sx={{ fontSize: '0.8125rem', color: c.text.secondary, flex: 1, letterSpacing: '0.01em' }}>
            {freeTrialSpent
              ? (refillLabel ? `Out of free runs, fresh ones in ${refillLabel}. ` : "You're out of free runs for now. ")
              : "Nice, you're rolling. "}
            <Box
              component="span"
              onClick={() => dispatch(openSettingsModal('models'))}
              sx={{ color: c.accent.primary, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
            >
              Connect the Claude or ChatGPT you already have
            </Box>
            {freeTrialSpent ? '.' : ' to keep going unlimited.'}
          </Typography>
          {!freeTrialSpent && (
            <Box
              role="button"
              aria-label="Dismiss"
              onClick={() => { try { localStorage.setItem('os_ft_nudge_dismissed', '1'); } catch {} setFtNudgeDismissed(true); }}
              sx={{ color: c.text.muted, cursor: 'pointer', fontSize: '1rem', lineHeight: 1, px: 0.5, '&:hover': { color: c.text.secondary } }}
            >
              ×
            </Box>
          )}
        </Box>
      </Collapse>

      <Collapse in={showUsageNudge && !fsHideChrome} timeout={300} unmountOnExit>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, flexShrink: 0 }}>
          {/* the bar is the message: how full your Pro window is. calm accent, never red. */}
          <Box sx={{ width: 132, height: 5, borderRadius: 3, bgcolor: c.border.medium, overflow: 'hidden', flexShrink: 0 }}>
            <Box sx={{ width: `${Math.round(proPct * 100)}%`, height: '100%', bgcolor: c.accent.primary, transition: 'width 0.3s ease' }} />
          </Box>
          {usageResetLabel && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, color: c.text.secondary }}>
              <Clock size={12} style={{ flexShrink: 0 }} />
              <Typography sx={{ fontSize: '0.8125rem', letterSpacing: '0.01em' }}>{usageResetLabel}</Typography>
            </Box>
          )}
          {proMaxed && (
            <Box
              component="span"
              onClick={() => dispatch(openSettingsModal('models'))}
              sx={{ color: c.accent.primary, cursor: 'pointer', fontSize: '0.8125rem', '&:hover': { textDecoration: 'underline' } }}
            >
              Upgrade
            </Box>
          )}
        </Box>
      </Collapse>

      {showUpdateBanner && !fsHideChrome && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 0.5,
            bgcolor: `${c.accent.primary}14`,
            borderBottom: `1px solid ${c.accent.primary}30`,
            flexShrink: 0,
          }}
        >
          <SystemUpdateAltIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.8125rem', color: c.text.secondary, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {updateStatus === 'available' && `OpenSwarm${verSuffix} is available`}
            {updateStatus === 'downloading' && `Downloading OpenSwarm${verSuffix}…`}
            {updateStatus === 'downloaded' && `OpenSwarm${verSuffix} is ready to install`}
          </Typography>
          {updateStatus === 'downloading' && (
            <LinearProgress
              variant="determinate"
              value={downloadPercent}
              sx={{
                width: 120,
                height: 3,
                flexShrink: 0,
                borderRadius: 2,
                bgcolor: `${c.accent.primary}20`,
                '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary, borderRadius: 2 },
              }}
            />
          )}
          {updateStatus === 'downloading' && (
            <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary, flexShrink: 0 }}>
              {Math.round(downloadPercent)}%
            </Typography>
          )}
          {updateStatus === 'available' && (
            <Button
              size="small"
              variant="contained"
              onClick={handleDownloadUpdate}
              sx={{
                bgcolor: c.accent.primary,
                '&:hover': { bgcolor: c.accent.pressed },
                textTransform: 'none',
                fontSize: '0.75rem',
                fontWeight: 600,
                borderRadius: 1.5,
                minWidth: 'auto',
                py: 0.25,
                px: 1.5,
                lineHeight: 1.5,
                flexShrink: 0,
              }}
            >
              Download
            </Button>
          )}
          {updateStatus === 'downloaded' && (
            <Button
              size="small"
              variant="contained"
              onClick={handleInstallUpdate}
              disabled={installing}
              startIcon={installing ? <CircularProgress size={12} sx={{ color: '#fff' }} /> : undefined}
              sx={{
                bgcolor: c.accent.primary,
                '&:hover': { bgcolor: c.accent.pressed },
                '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.7 },
                textTransform: 'none',
                fontSize: '0.75rem',
                fontWeight: 600,
                borderRadius: 1.5,
                minWidth: 'auto',
                py: 0.25,
                px: 1.5,
                lineHeight: 1.5,
                flexShrink: 0,
              }}
            >
              {installing ? 'Restarting…' : 'Restart & Update'}
            </Button>
          )}
          <IconButton
            size="small"
            onClick={handleDismissBanner}
            sx={{ color: c.text.tertiary, p: 0.25, flexShrink: 0, '&:hover': { color: c.text.secondary } }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      )}

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {((!sidebarCollapsed && (!fsHideChrome || fsSidebarPinned)) || sideOverlay) && (
      <>
      <Box
        onMouseEnter={() => { if (sideOverlay) cancelPeekClose(); }}
        onMouseLeave={() => { if (sideOverlay) schedulePeekClose(); }}
        onWheel={handleSidebarSwipe}
        sx={{
          width: sidebarWidth,
          flexShrink: 0,
          bgcolor: c.bg.secondary,
          display: 'flex',
          flexDirection: 'column',
          // Zen/Arc compact mode: a detached, rounded panel that SLIDES in and out from the left edge
          // (sidePeek drives the transform both ways; it stays mounted so leaving glides it away, not vanish).
          ...(sideOverlay ? {
            // Hug the window's top/left/bottom edges (same footprint as the docked sidebar) so the
            // dashboard's corner tint can't peek in the margins; only the dashboard-facing right corners
            // stay rounded. The OS clips the square outer corners to the window's own rounding, so the
            // window edge (the "last border") stays intact.
            position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 1000002,
            borderRadius: '0 14px 14px 0', overflow: 'hidden',
            boxShadow: '8px 0 32px rgba(0,0,0,0.28)', borderRight: `1px solid ${c.border.medium}`,
            transform: sidePeek ? 'translateX(0)' : 'translateX(-118%)',
            transition: 'transform 240ms cubic-bezier(0.22,1,0.36,1)',
            pointerEvents: sidePeek ? 'auto' : 'none',
          } : {}),
        }}
      >
        {/* Sidebar header = the app's chrome home (Arc/Zen): window-light clearance, back/forward, collapse, then the search command bar. */}
        <Box sx={{ pt: '30px', px: 1, pb: 0.75, display: 'flex', flexDirection: 'column', gap: 0.75, WebkitAppRegion: 'drag', flexShrink: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, WebkitAppRegion: 'no-drag' }}>
            <Tooltip title="Back">
              <span>
                <IconButton size="small" onClick={() => navigate(-1)} disabled={!canGoBack}
                  sx={{ color: c.text.tertiary, p: 0.5, borderRadius: 1, '& svg': { transition: 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1)' }, '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` }, '&:hover svg': { transform: 'translateX(-2px)' } }}>
                  <ArrowLeft size={17} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Forward">
              <span>
                <IconButton size="small" onClick={() => navigate(1)} disabled={!canGoForward}
                  sx={{ color: c.text.tertiary, p: 0.5, borderRadius: 1, '& svg': { transition: 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1)' }, '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` }, '&:hover svg': { transform: 'translateX(2px)' } }}>
                  <ArrowRight size={17} />
                </IconButton>
              </span>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            <Tooltip title={sideOverlay ? 'Dock sidebar' : 'Hide sidebar'}>
              {/* Arc-style pin: from the floating peek this DOCKS the sidebar permanently (pushes the
                  canvas), from docked it collapses back to peek. Toggle, not one-way collapse. */}
              <IconButton size="small" onClick={() => {
                  if (fsActive) {
                    setFsSidebarPinned((v) => {
                      if (!v) setSidebarCollapsed(false);
                      return !v;
                    });
                    return;
                  }
                  setSidebarCollapsed((v) => !v);
                }}
                data-onboarding="sidebar-toggle" aria-expanded={!sidebarCollapsed}
                sx={{ color: c.text.tertiary, p: 0.5, borderRadius: 1, '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` } }}>
                <AnimatedPanelLeft size={17} />
              </IconButton>
            </Tooltip>
          </Box>
          <ButtonBase
            onClick={() => window.dispatchEvent(new CustomEvent('openswarm:open-search'))}
            sx={{
              WebkitAppRegion: 'no-drag',
              display: 'flex', alignItems: 'center', gap: 1, width: '100%', justifyContent: 'flex-start',
              px: 1.25, py: 0.9, borderRadius: 2, border: `1px solid ${c.border.medium}`, bgcolor: c.bg.surface,
              color: c.text.tertiary, transition: 'border-color 0.15s, background 0.15s',
              '&:hover': { borderColor: c.border.strong, bgcolor: c.bg.page },
            }}
          >
            <SearchGlyph size={15} />
            <Typography sx={{ flex: 1, textAlign: 'left', fontSize: '0.875rem', color: c.text.muted }}>Search</Typography>
            <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost, fontFamily: c.font.mono }}>{SEARCH_HOTKEY_LABEL}</Typography>
          </ButtonBase>
        </Box>
        <Box sx={{
          flex: 1,
          overflow: 'auto',
          pt: 0.5,
          '&::-webkit-scrollbar': { width: 0 },
          // Tactile hover: the leading section icon springs once on row-hover, then settles. Interaction-only, never ambient. Scoped to ListItemIcon so the +/chevron stay put.
          '& .MuiListItemIcon-root svg': {
            transition: 'transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)',
          },
          // Per-glyph hover choreography: each section icon reacts in its own way, springy then settles. Interaction-only, never ambient.
          '& [data-onboarding="sidebar-dashboards"]:hover .MuiListItemIcon-root svg': {
            transform: 'scale(1.14)',
          },
          '& [data-onboarding="sidebar-apps"]:hover .MuiListItemIcon-root svg': {
            transform: 'rotate(8deg) scale(1.08)',
          },
        }}>
          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={handleDashboardsClick}
              data-onboarding="sidebar-dashboards"
              // Onboarding reads expanded so it skips the click step (re-click would collapse).
              data-expanded={dashboardsExpanded ? 'true' : 'false'}
              aria-expanded={dashboardsExpanded}
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isDashboardRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isDashboardRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isDashboardRoute ? c.accent.primary : c.text.tertiary, minWidth: 28 }}>
                <LayoutDashboard size={18} />
              </ListItemIcon>
              <ListItemText
                primary="Dashboards"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isDashboardRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.875rem',
                    fontWeight: isDashboardRoute ? 600 : 400,
                  },
                }}
              />
              <Tooltip title="New dashboard" placement="right">
                <IconButton
                  size="small"
                  onClick={handleCreateDashboard}
                  sx={{
                    color: c.text.ghost,
                    p: 0.25,
                    mr: 0.25,
                    borderRadius: 1,
                    '&:hover': { color: c.accent.primary, bgcolor: `${c.accent.primary}14` },
                  }}
                >
                  <Plus size={15} />
                </IconButton>
              </Tooltip>
              {dashboardList.length > 0 && (
                <ExpandMoreIcon
                  sx={{
                    color: c.text.ghost,
                    fontSize: 16,
                    transition: 'transform 0.2s',
                    transform: dashboardsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                />
              )}
            </ListItemButton>

            <Collapse in={dashboardsExpanded && dashboardList.length > 0} timeout={200}>
              <Box
                sx={{
                  ml: 2,
                  mt: 0.25,
                  mb: 0.5,
                  maxHeight: 240,
                  overflow: 'auto',
                  '&::-webkit-scrollbar': { width: 3 },
                  '&::-webkit-scrollbar-track': { background: 'transparent' },
                  '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 4 },
                  scrollbarWidth: 'thin',
                  scrollbarColor: `${c.border.medium} transparent`,
                }}
              >
                {dashboardList.map((entry, idx) => {
                  const isActive = activeDashboardId === entry.id;
                  const isRenaming = renamingDashboardId === entry.id;
                  return (
                    <Box
                      key={entry.id}
                      // First row gets generic "first" alias so onboarding can teach "click into a dashboard" without a specific id.
                      data-onboarding={
                        idx === 0 ? 'dashboard-row-first' : `dashboard-row-${entry.id}`
                      }
                      onClick={() => handleDashboardItemClick(entry.id)}
                      onContextMenu={(e) => openRowMenu(e, 'dashboard', entry.id, entry.name)}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 1,
                        py: isRenaming ? 0.25 : 0.5,
                        mx: 0.5,
                        cursor: isRenaming ? 'default' : 'pointer',
                        // Finder-style selection: the rounded fill is the one active cue, no rail marker.
                        borderRadius: `${c.radius.md}px`,
                        bgcolor: isActive ? `${c.accent.primary}40` : 'transparent',
                        '&:hover': { bgcolor: isActive ? `${c.accent.primary}55` : `${c.text.tertiary}0A` },
                        transition: 'background-color 0.12s',
                      }}
                    >
                      {isRenaming ? (
                        <InputBase
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleDashboardRenameSubmit(entry.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleDashboardRenameSubmit(entry.id);
                            if (e.key === 'Escape') setRenamingDashboardId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => e.target.select()}
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '0.875rem',
                            fontWeight: isActive ? 500 : 400,
                            color: isActive ? c.text.secondary : c.text.ghost,
                            py: 0,
                            px: 0.5,
                            borderRadius: 0.75,
                            border: `1px solid ${c.accent.primary}80`,
                            bgcolor: `${c.bg.page}`,
                            '& input': {
                              padding: '1px 0',
                            },
                          }}
                        />
                      ) : (
                        <Typography
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            handleStartDashboardRename(entry.id, entry.name);
                          }}
                          sx={{
                            color: isActive ? c.text.secondary : c.text.ghost,
                            fontSize: '0.875rem',
                            fontWeight: isActive ? 500 : 400,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {entry.name}
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

          {/* Sections separate with air, not lines. */}
          <Box sx={{ my: 0.75 }} />

          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={handleAppsClick}
              onMouseEnter={() => {
                const fn = (window as any).__openswarmPrefetchRoute;
                if (typeof fn === 'function') fn('/apps');
              }}
              data-onboarding="sidebar-apps"
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isAppsRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isAppsRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isAppsRoute ? c.accent.primary : c.text.tertiary, minWidth: 28 }}>
                <LayoutGrid size={18} />
              </ListItemIcon>
              <ListItemText
                primary="Apps"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isAppsRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.875rem',
                    fontWeight: isAppsRoute ? 600 : 400,
                  },
                }}
              />
              {appsList.length > 0 && (
                <ExpandMoreIcon
                  sx={{
                    color: c.text.ghost,
                    fontSize: 16,
                    transition: 'transform 0.2s',
                    transform: appsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                />
              )}
            </ListItemButton>

            <Collapse in={appsExpanded && appsList.length > 0} timeout={200}>
              <Box
                sx={{
                  ml: 2,
                  mt: 0.25,
                  mb: 0.5,
                  maxHeight: 240,
                  overflow: 'auto',
                  '&::-webkit-scrollbar': { width: 3 },
                  '&::-webkit-scrollbar-track': { background: 'transparent' },
                  '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 4 },
                  scrollbarWidth: 'thin',
                  scrollbarColor: `${c.border.medium} transparent`,
                }}
              >
                {appsList.map((app) => {
                  if (pendingDelete?.id === app.id) return null;  // hidden while its Undo toast is up
                  const isActive = openViewCardOutputIds.has(app.id);
                  const isRenamingApp = renamingAppId === app.id;
                  const appName = app.name || 'Untitled App';
                  return (
                    <Box
                      key={app.id}
                      onClick={() => { if (!isRenamingApp) navigateToApp(app.id); }}
                      onContextMenu={(e) => openRowMenu(e, 'app', app.id, appName)}
                      onMouseEnter={(e) => {
                        if (isRenamingApp) return;
                        const top = e.currentTarget.getBoundingClientRect().top;
                        if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
                        peekTimerRef.current = setTimeout(() => setPeek({ name: appName, description: app.description || '', thumbnail: app.thumbnail || null, top }), 350);
                      }}
                      onMouseLeave={() => {
                        if (peekTimerRef.current) { clearTimeout(peekTimerRef.current); peekTimerRef.current = null; }
                        setPeek(null);
                      }}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 0.5,
                        py: isRenamingApp ? 0.25 : 0.5,
                        mx: 0.5,
                        cursor: isRenamingApp ? 'default' : 'pointer',
                        borderRadius: `${c.radius.md}px`,
                        bgcolor: isActive ? `${c.accent.primary}40` : 'transparent',
                        '&:hover': { bgcolor: isActive ? `${c.accent.primary}55` : `${c.text.tertiary}0A` },
                        '& .app-del-btn': { opacity: 0, transition: 'opacity 0.12s' },
                        '&:hover .app-del-btn': { opacity: 1 },
                        transition: 'background-color 0.12s',
                      }}
                    >
                      {isRenamingApp ? (
                        <InputBase
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleAppRenameSubmit(app.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAppRenameSubmit(app.id);
                            if (e.key === 'Escape') setRenamingAppId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => e.target.select()}
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '0.875rem',
                            fontWeight: isActive ? 500 : 400,
                            color: isActive ? c.text.secondary : c.text.ghost,
                            py: 0,
                            px: 0.5,
                            borderRadius: 0.75,
                            border: `1px solid ${c.accent.primary}80`,
                            bgcolor: `${c.bg.page}`,
                            '& input': { padding: '1px 0' },
                          }}
                        />
                      ) : (
                        <>
                          <Typewriter value={appName} enabled={!!app.name && app.name !== 'Untitled App'}>
                            {(t) => (
                              <Typography
                                onDoubleClick={(e) => { e.stopPropagation(); handleStartAppRename(app.id, appName); }}
                                sx={{
                                  color: isActive ? c.text.secondary : c.text.ghost,
                                  fontSize: '0.875rem',
                                  fontWeight: isActive ? 500 : 400,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  flex: 1,
                                  minWidth: 0,
                                }}
                              >
                                {t}
                              </Typography>
                            )}
                          </Typewriter>
                          <IconButton
                            className="app-del-btn"
                            size="small"
                            aria-label={`Delete ${appName}`}
                            onClick={(e) => handleDeleteApp(e, app.id, appName)}
                            sx={{ p: 0.25, flexShrink: 0, color: c.text.ghost, '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}18` } }}
                          >
                            <CloseGlyph size={13} />
                          </IconButton>
                        </>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

        </Box>

        <Box
          sx={{
            px: 1,
            py: 1.25,
          }}
        >
          <ListItemButton
            onClick={() => dispatch(openSettingsModal())}
            data-onboarding="sidebar-settings-button"
            sx={{
              borderRadius: 1.5,
              py: 0.6,
              px: 1.25,
              '& .MuiListItemIcon-root svg': { transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)' },
              '&:hover': { bgcolor: `${c.text.tertiary}0A` },
              '&:hover .MuiListItemIcon-root svg': { transform: 'rotate(90deg)' },
              transition: 'background-color 0.15s',
            }}
          >
            <ListItemIcon sx={{ color: c.text.tertiary, minWidth: 28, position: 'relative' }}>
              <LucideSettings size={18} />
              {showUpdateDot && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: 2,
                    right: 10,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    bgcolor: c.accent.primary,
                    border: `1.5px solid ${c.bg.secondary}`,
                  }}
                />
              )}
            </ListItemIcon>
            <ListItemText
              primary="Settings"
              sx={{
                '& .MuiListItemText-primary': {
                  color: c.text.muted,
                  fontSize: '0.875rem',
                  fontWeight: 400,
                },
              }}
            />
          </ListItemButton>
        </Box>
      </Box>
      <Box
        onMouseDown={handleResizeStart}
        onDoubleClick={handleResizeDoubleClick}
        sx={{
          // Hide the resize seam when the sidebar is a floating overlay (nothing to resize against).
          display: sideOverlay ? 'none' : 'block',
          // 6px hit-target at -3px margin overlaps the seam so the drag region doesn't read as a visible empty strip.
          width: 6,
          marginLeft: '-3px',
          marginRight: '-3px',
          flexShrink: 0,
          cursor: 'col-resize',
          position: 'relative',
          zIndex: 10,
          '&::after': {
            content: '""',
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 2,
            bgcolor: 'transparent',
            transition: 'background-color 0.2s',
          },
          '&:hover::after': {
            bgcolor: c.border.strong,
          },
          '&:active::after': {
            bgcolor: `${c.accent.primary}40`,
          },
        }}
      />
      </>
      )}

      <Box sx={{
        flex: 1,
        overflow: 'hidden',
        bgcolor: c.bg.page,
        position: 'relative',
        // Float the content as a rounded inset panel ("column pill"): the chrome (bg.secondary) frames it, so there are no divider lines, just air + radius. Fullscreen drops the frame entirely.
        mt: fsHideChrome ? 0 : '6px',
        mr: fsHideChrome ? 0 : '6px',
        mb: fsHideChrome ? 0 : '6px',
        ml: fsHideChrome ? 0 : '6px',
        borderRadius: fsHideChrome ? 0 : '14px',
      }}>
        {/* One voice controller wraps BOTH the routed content and the persistent Dashboard host, so
            the spawn-pill mic (which lives in the persistent host, not the Outlet) shares the recorder. */}
        <VoiceDictationProvider>
          {/* Hidden (not unmounted) when the dashboard view is active so the persistent Dashboard layered above can take over. */}
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              visibility: isDashboardViewActive ? 'hidden' : 'visible',
              pointerEvents: isDashboardViewActive ? 'none' : 'auto',
            }}
          >
            <Outlet />
          </Box>

          {/* CSS-hidden on other routes so webviews + state survive nav. */}
          {lastDashboardId && (
            <DashboardHost visible={isDashboardViewActive}>
              <Dashboard dashboardId={lastDashboardId} isActive={isDashboardViewActive} />
            </DashboardHost>
          )}
        </VoiceDictationProvider>
      </Box>
      </Box>

      <React.Suspense fallback={null}>
        <Settings />
      </React.Suspense>

      <Snackbar
        open={showUpdateSnackbar}
        autoHideDuration={10000}
        onClose={() => setSnackbarDismissed(true)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="info"
          icon={updateStatus === 'downloaded'
            ? <RestartAltIcon sx={{ fontSize: 18 }} />
            : <SystemUpdateAltIcon sx={{ fontSize: 18 }} />
          }
          action={
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                size="small"
                onClick={() => setSnackbarDismissed(true)}
                sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.8125rem', minWidth: 'auto' }}
              >
                Dismiss
              </Button>
              {updateStatus === 'available' && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleDownloadUpdate}
                  sx={{
                    bgcolor: c.accent.primary,
                    '&:hover': { bgcolor: c.accent.pressed },
                    textTransform: 'none',
                    fontSize: '0.8125rem',
                    borderRadius: 1.5,
                    minWidth: 'auto',
                  }}
                >
                  Download
                </Button>
              )}
              {updateStatus === 'downloaded' && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleInstallUpdate}
                  disabled={installing}
                  startIcon={installing ? <CircularProgress size={12} sx={{ color: '#fff' }} /> : undefined}
                  sx={{
                    bgcolor: c.accent.primary,
                    '&:hover': { bgcolor: c.accent.pressed },
                    '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.7 },
                    textTransform: 'none',
                    fontSize: '0.8125rem',
                    borderRadius: 1.5,
                    minWidth: 'auto',
                  }}
                >
                  {installing ? 'Restarting…' : 'Restart & Update'}
                </Button>
              )}
            </Box>
          }
          sx={{
            bgcolor: c.bg.surface,
            color: c.text.primary,
            border: `1px solid ${c.border.medium}`,
            boxShadow: c.shadow.md,
            '& .MuiAlert-icon': { color: c.accent.primary },
          }}
        >
          {updateStatus === 'available' && `OpenSwarm${verSuffix} is available`}
          {updateStatus === 'downloaded' && `OpenSwarm${verSuffix} downloaded; restart to update`}
        </Alert>
      </Snackbar>

      {/* Arc-style peek: a live-thumbnail preview beside the sidebar while hovering an app row. Non-interactive so it never steals the hover. */}
      {peek && !sidebarCollapsed && (
        <Box
          sx={{
            position: 'fixed',
            left: sidebarWidth + 8,
            top: Math.min(Math.max(peek.top - 8, 12), window.innerHeight - 232),
            width: 264,
            zIndex: 1400,
            pointerEvents: 'none',
            borderRadius: `${c.radius.lg}px`,
            overflow: 'hidden',
            bgcolor: c.bg.surface,
            border: `1px solid ${c.border.medium}`,
            boxShadow: c.shadow.lg,
            '@keyframes peekIn': { from: { opacity: 0, transform: 'translateX(-6px)' }, to: { opacity: 1, transform: 'none' } },
            animation: 'peekIn 0.14s ease-out',
          }}
        >
          {peek.thumbnail ? (
            <Box component="img" src={peek.thumbnail} alt="" sx={{ width: '100%', height: 150, objectFit: 'cover', objectPosition: 'top left', display: 'block' }} />
          ) : (
            <Box sx={{ width: '100%', height: 92, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: `${c.text.tertiary}0A`, color: c.text.ghost, fontSize: '0.75rem' }}>
              No preview yet
            </Box>
          )}
          <Box sx={{ p: 1.25 }}>
            <Typography sx={{ fontWeight: 600, fontSize: '0.875rem', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peek.name}</Typography>
            {peek.description && (
              <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mt: 0.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {peek.description}
              </Typography>
            )}
          </Box>
        </Box>
      )}

      {/* Right-click a dashboard or app row: the same actions as the Dashboards grid, at the cursor. */}
      <Menu
        anchorReference="anchorPosition"
        anchorPosition={rowMenu ? { top: rowMenu.top, left: rowMenu.left } : undefined}
        open={!!rowMenu}
        onClose={closeRowMenu}
        slotProps={{ paper: { sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, boxShadow: c.shadow.lg, minWidth: 160 } } }}
      >
        <MenuItem onClick={rowMenuRename}>
          <ListItemIcon><EditIcon sx={{ fontSize: 18 }} /></ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>
        {rowMenu?.kind === 'dashboard' && (
          <MenuItem onClick={rowMenuDuplicate}>
            <ListItemIcon><ContentCopyIcon sx={{ fontSize: 18 }} /></ListItemIcon>
            <ListItemText>Duplicate</ListItemText>
          </MenuItem>
        )}
        <MenuItem onClick={rowMenuDelete} sx={{ color: c.status.error }}>
          <ListItemIcon><DeleteOutlineIcon sx={{ fontSize: 18, color: c.status.error }} /></ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>

      {/* Arc-style Undo for a just-deleted app. Open while the delete is pending; our own 6s timer commits it and closes this. */}
      <Snackbar
        open={!!pendingDelete}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert
          severity="info"
          icon={false}
          action={
            <Button
              size="small"
              onClick={handleUndoDeleteApp}
              sx={{ color: c.accent.primary, textTransform: 'none', fontWeight: 700, fontSize: '0.8125rem', minWidth: 'auto' }}
            >
              Undo
            </Button>
          }
          sx={{
            bgcolor: c.bg.surface,
            color: c.text.primary,
            border: `1px solid ${c.border.medium}`,
            boxShadow: c.shadow.md,
            '& .MuiAlert-action': { alignItems: 'center', pt: 0 },
          }}
        >
          {`Deleted "${pendingDelete?.name ?? ''}"`}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default AppShell;
