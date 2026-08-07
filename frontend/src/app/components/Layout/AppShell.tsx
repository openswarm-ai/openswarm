import React, { useState, useEffect, useCallback, startTransition, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { openSettingsCard } from '@/shared/state/dashboardLayoutSlice';
import { getLastInteractedBrowser, getKeepAliveBrowserIds, setLastInteractedBrowser, clearLastInteractedBrowser } from '@/shared/browserFocus';
import { getWebview } from '@/shared/browserRegistry';
import { applyBrowserZoom } from '@/shared/browserZoom';
import Box from '@mui/material/Box';
import { VoiceDictationProvider } from '@/shared/voice/VoiceDictationContext';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import { Clock } from 'lucide-react';

// Settings modal lazy-loaded so its 2.3K LOC + Stripe/OAuth helpers don't ship on first paint.
import DynamicIsland from '@/app/components/overlays/DynamicIsland';
import Dashboard from '@/app/pages/Dashboard/Dashboard';
import DashboardHost from '@/app/components/Layout/DashboardHost';
import { useLastDashboardId } from '@/shared/hooks/useLastDashboardId';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { hasModelConnected as selectHasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { shallowEqual } from 'react-redux';
import { fetchDashboards, createDashboard } from '@/shared/state/dashboardsSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { addBrowserCard, addBrowserTab, cycleBrowserTab, reopenLastClosed, addViewCard, selectFullscreenCardId, setTiledCard, clearTiledCard, openWorkflowMonitor, openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import { ackRun, runWorkflowNow } from '@/shared/state/workflowsSlice';
import { setPendingBrowserUrl } from '@/shared/state/tempStateSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import UpdateReadyPill from '@/app/components/Layout/UpdateReadyPill';
import ShareRequestHost from '@/app/components/share/ShareRequestHost';
import CardContextMenu from '@/app/pages/Dashboard/desktop/CardContextMenu';
import { findBrowserByWebContentsId } from '@/shared/browserRegistry';
import { byPreviewRecency } from '@/shared/previewOrder';
import { useClaudeTokens, useThemeAccent, useThemeWash } from '@/shared/styles/ThemeContext';
import SpacesStrip from '@/app/pages/Dashboard/desktop/SpacesStrip';
import { washOpaqueBackgroundUrl, washUnderlayColor, effectiveWashStops } from '@/shared/styles/washBackground';
import { useGrainTileUrl } from '@/shared/styles/useGrainTileUrl';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';

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
  // Desktop shell: the wallpaper canvas IS the home surface, so the sidebar starts docked away
  // (left-edge hover peeks it; the pin toggle brings it back full-time).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

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
  // The models list is marked loaded even when its fetch fails, so it alone can't tell "no model" from "couldn't ask". Settings is where the user's own key/sub lives, so the banner waits for it.
  const settingsKnown = useAppSelector((s) => s.settings.loaded);
  // "Connected" = the user's OWN model (key/sub/pro/custom), NOT a non-empty /models list: the free-trial Haiku is always in that list now, so a byProvider-length check would falsely read as connected and hide the out-of-runs banner.
  const hasModelConnected = useAppSelector(selectHasModelConnected);
  // While onboarding owns the window, the floating sidebar (and its hover-peek strip) must not exist; both out-z the overlay.
  const v3FlowActive = useAppSelector((st) => st.onboardingV3.flowActive);
  // Arc/Zen fullscreen ground: ONE themed wash across the whole window (sidebar sits on it borderless,
  // the content floats as a rounded card). Mirrors the DashboardCanvas wash formula.
  const { accent: themeAccent, gradient: themeGradient } = useThemeAccent();
  const { washOpacity: themeWashOpacity, grain: themeWashGrain } = useThemeWash();
  const shellGrainUrl = useGrainTileUrl(themeWashGrain);
  const fsWashStops = effectiveWashStops(themeGradient, themeAccent);
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
  const settingsSettled = useAppSelector((s) => s.settings.settled);
  const backendUnreachable = settingsSettled && !settingsKnown;
  const showWarningBanner = !isOnline || backendUnreachable || (settingsKnown && modelsLoaded && freeTrialArmSettled && !hasModelConnected && !freeTrialActive && !freeTrialSpent);
  const [ftNudgeDismissed, setFtNudgeDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem('os_ft_nudge_dismissed') === '1'; } catch { return false; }
  });
  // Spent nudge hides the moment they connect a real model; the post-wow nudge only shows on the trial lane (so it already implies no own model) and is dismissible.
  const showFreeTrialNudge = isOnline && settingsKnown && ((freeTrialSpent && !hasModelConnected) || (freeTrialUsed && !ftNudgeDismissed));

  // shallowEqual on top-level Immer dicts: nested mutations bump the dict reference, causing AppShell to re-render on every rename/output bump despite identical structure.
  const dashboardItems = useAppSelector(
    (state) => state.dashboards.items,
    shallowEqual,
  );
  const dashboardList = React.useMemo(
    () => Object.values(dashboardItems).sort(byPreviewRecency),
    [dashboardItems],
  );

  useEffect(() => {
    dispatch(fetchDashboards());
    dispatch(fetchOutputs());
  }, [dispatch]);

  // Idle-prefetch the lazy Settings chunk so click-to-open is instant; requestIdleCallback avoids fighting first-paint.
  useEffect(() => {
    const ric = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1500));
    const handle = ric(() => {
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

  // A click or an action button on the OS notification a finished workflow posted. Every outcome lands on something real; an unwired button on a notification is worse than no button.
  useEffect(() => {
    const bridge = window.openswarm;
    if (!bridge?.onNotificationAction) return;
    return bridge.onNotificationAction(({ outcome, runId, workflowId }) => {
      if (!workflowId) return;
      switch (outcome) {
        case 'open': dispatch(openWorkflowMonitor({ workflowId, runId })); break;
        case 'ack': if (runId) dispatch(ackRun(runId)); break;
        case 'rerun': dispatch(runWorkflowNow(workflowId)); break;
        case 'edit': dispatch(openWorkflowsApp({ workflowId })); break;
      }
    });
  }, [dispatch]);

  // Zoom / find / tab-cycle from a focused browser GUEST (keydowns inside a webview can't reach this document, so main forwards them with the guest's id). Targets that exact browser; the host-focused counterparts live in the keydown below + useCanvasControls (zoom).
  useEffect(() => {
    const w = window as any;
    if (!w.openswarm?.onBrowserShortcut) return;
    return w.openswarm.onBrowserShortcut((payload: { action: string; webContentsId: number }) => {
      // Reopen-last-closed is global (no target browser), so handle it before the per-browser id guard.
      if (payload.action === 'reopen-closed') { dispatch(reopenLastClosed()); return; }
      if (payload.action === 'new-agent') { window.dispatchEvent(new CustomEvent('openswarm:new-agent')); return; }
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
  // Fullscreen still hides the top-center island anchor + banners; the sidebar floats in on peek.
  const fsHideChrome = fsActive;
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


  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: c.bg.secondary,
      // Identical rendering to the canvas wash (opaque pre-blend + the same baked grain tile), so any
      // sliver of shell peeking past the viewport reads as continuous texture, never a tint/grain seam.
      ...(fsWashStops ? {
        backgroundColor: washUnderlayColor(fsWashStops, themeWashOpacity, c.bg.page),
        backgroundImage: shellGrainUrl
          ? `${shellGrainUrl}, ${washOpaqueBackgroundUrl(fsWashStops, themeWashOpacity, c.bg.page)}`
          : washOpaqueBackgroundUrl(fsWashStops, themeWashOpacity, c.bg.page),
        backgroundSize: shellGrainUrl ? 'auto, 100% 100%' : '100% 100%',
        backgroundRepeat: shellGrainUrl ? 'repeat, no-repeat' : 'no-repeat',
      } : {}),
    }}>
      {/* Sidebar retired: dashboards switch via the macOS-Spaces top strip; a slim band below the
          spaces hot zone keeps the frameless window draggable (the sidebar's drag strip is gone). */}
      {isDashboardViewActive && !v3FlowActive && <SpacesStrip />}
      <Box sx={{ position: 'fixed', top: 3, left: 260, right: 0, height: 22, zIndex: 5, WebkitAppRegion: 'drag' }} />
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
              : backendUnreachable
              ? 'Cannot reach the OpenSwarm backend; your settings and agents are unavailable until it comes back'
              : (
                <>
                  No AI model connected.{' '}
                  <Box
                    component="span"
                    onClick={() => dispatch(openSettingsCard({ tab: 'models' }))}
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
              onClick={() => dispatch(openSettingsCard({ tab: 'models' }))}
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
              onClick={() => dispatch(openSettingsCard({ tab: 'models' }))}
              sx={{ color: c.accent.primary, cursor: 'pointer', fontSize: '0.8125rem', '&:hover': { textDecoration: 'underline' } }}
            >
              Upgrade
            </Box>
          )}
        </Box>
      </Collapse>

      {!fsHideChrome && <UpdateReadyPill />}

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Sidebar excised: dashboards live in the Spaces strip (hover the top edge; right-click a tile for rename/duplicate/delete). */}

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
      </React.Suspense>

      <ShareRequestHost />

      {/* Shell-global right-click host (portals to body): chat surfaces render on non-dashboard routes too, so the menu can't live inside DashboardCanvas. */}
      <CardContextMenu />


    </Box>
  );
};

export default AppShell;
