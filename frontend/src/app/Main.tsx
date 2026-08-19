import React, { useMemo, useEffect, useState, useRef, Suspense } from 'react';
import { Provider } from 'react-redux';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider as MuiThemeProvider, createTheme, CssBaseline } from '@mui/material';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { store } from '../shared/state/store';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchSettings, updateSettingsPatch, markFreeTrialArmSettled } from '@/shared/state/settingsSlice';
import { fetchSubscriptionStatus } from '@/shared/state/subscriptionsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import { updateSessionModel, persistSessionModel } from '@/shared/state/agentsSlice';
import { API_BASE } from '@/shared/config';
import {
  setAppVersion,
  setUpdateAvailable,
  setUpdateNotAvailable,
  setDownloading,
  setUpdateDownloaded,
  setUpdateError,
} from '@/shared/state/updateSlice';
import AppShell from './components/Layout/AppShell';
import ImportEntryPoint from './components/share/ImportEntryPoint';
import DashboardAutoEnter from './pages/DashboardAutoEnter/DashboardAutoEnter';
import ErrorBoundary from './components/feedback/ErrorBoundary';
import { setPanelMode, disableOnboardingAfterCrash } from '@/shared/state/onboardingProgressSlice';

const Analytics = React.lazy(() => import('./pages/Analytics/Analytics'));
const OnboardingV3Root = React.lazy(() => import('./components/OnboardingV3/OnboardingV3Root'));
const SignInRequiredGate = React.lazy(() => import('./components/overlays/SignInRequiredGate'));
const OnboardingRoot = React.lazy(() =>
  import('./components/Onboarding').then((m) => ({ default: m.OnboardingRoot })),
);

if (typeof window !== 'undefined') {
  // Diagnostic global error capture. The packaged bundle has no source maps, so without these handlers the only thing that reaches main-process stderr is "Uncaught TypeError: ... (bundle.js:2)" with zero stack context. Forward error.stack and Redux action.type when available so we can pinpoint the offender across the chat-spawn / workflow rendering paths even in minified prod.
  window.addEventListener('error', (e) => {
    try {
      // eslint-disable-next-line no-console
      console.error('[diag][window.error]', e.message, '@', e.filename, ':', e.lineno, ':', e.colno, '\nstack:\n', e.error && (e.error as Error).stack);
    } catch { /* never let the handler itself throw */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = (e as PromiseRejectionEvent).reason;
      // eslint-disable-next-line no-console
      console.error('[diag][window.unhandledrejection]', reason && reason.message, '\nstack:\n', reason && reason.stack);
    } catch { /* never let the handler itself throw */ }
  });

  (window as any).__openswarmPrefetchRoute = (path: string) => {
    switch (path) {
      case '/views':
      case '/analytics': void import('./pages/Analytics/Analytics'); return;
    }
  };
  const prefetchAll = () => {
    void import('./pages/Analytics/Analytics');
  };
  const ric = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout?: number }) => number)
    | undefined;
  if (ric) ric(prefetchAll, { timeout: 1500 });
  else window.setTimeout(prefetchAll, 500);
}
import { report, reportAppOpened, getSessionTraceState, getRecentActions } from '@/shared/serviceClient';
import { installUxSignals } from '@/shared/uxSignals';
import { useRouteTracker } from '@/shared/hooks/useRouteTracker';
import { useDeepLink } from '@/shared/hooks/useDeepLink';
import { useKeepPageScaleSane } from '@/shared/hooks/useKeepPageScaleSane';
import { useWindowFocus } from '@/shared/hooks/useWindowFocus';
import { useInteractionHeartbeat } from '@/shared/hooks/useInteractionHeartbeat';
import { ThemeProvider, useThemeMode, useThemeAccent, useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { alertStyleOverrides } from '@/shared/styles/alertOverrides';
import { inputStyleOverrides } from '@/shared/styles/inputOverrides';

function buildMuiTheme(c: ClaudeTokens, mode: 'light' | 'dark') {
  return createTheme({
    palette: {
      mode,
      background: {
        default: c.bg.page,
        paper: c.bg.surface,
      },
      primary: {
        main: c.accent.primary,
        dark: c.accent.pressed,
        light: c.accent.hover,
      },
      text: {
        primary: c.text.primary,
        secondary: c.text.muted,
        disabled: c.text.tertiary,
      },
      divider: c.border.medium,
      error: { main: c.status.error },
      warning: { main: c.status.warning },
      success: { main: c.status.success },
      info: { main: c.status.info },
    },
    typography: {
      fontFamily: c.font.sans,
      h1: { fontWeight: 600 },
      h2: { fontWeight: 600 },
      h3: { fontWeight: 600 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
      button: { textTransform: 'none' as const, fontWeight: 500 },
    },
    shape: {
      borderRadius: c.radius.xl,
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: c.bg.page,
            color: c.text.primary,
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.border.strong} transparent`,
          },
          '*': {
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.border.strong} transparent`,
          },
          '*::-webkit-scrollbar': {
            width: '6px',
            height: '6px',
          },
          '*::-webkit-scrollbar-track': {
            background: 'transparent',
          },
          '*::-webkit-scrollbar-thumb': {
            background: c.border.strong,
            borderRadius: '3px',
          },
          '*::-webkit-scrollbar-thumb:hover': {
            background: c.text.ghost,
          },
          '*::-webkit-scrollbar-corner': {
            background: 'transparent',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: c.radius.lg,
            transition: c.transition,
            textTransform: 'none' as const,
            '&:active': { transform: 'scale(0.98)' },
          },
          contained: {
            boxShadow: 'none',
            '&:hover': { boxShadow: 'none' },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            boxShadow: c.shadow.md,
            border: `1px solid ${c.border.subtle}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            fontWeight: 500,
            borderRadius: c.radius.md,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            boxShadow: c.shadow.lg,
            border: `1px solid ${c.border.subtle}`,
          },
        },
      },
      MuiAlert: { styleOverrides: alertStyleOverrides(c) },
      MuiOutlinedInput: { styleOverrides: inputStyleOverrides(c) },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: c.bg.inverse,
            color: c.text.inverse,
            fontSize: '0.75rem',
          },
        },
      },
    },
  });
}

const DeepLinkListener: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useDeepLink();
  useKeepPageScaleSane();
  useWindowFocus();
  useInteractionHeartbeat();
  return <>{children}</>;
};

const SettingsLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const { setMode: setThemeMode } = useThemeMode();
  const { setAccent, setGradient } = useThemeAccent();
  const theme = useAppSelector((s) => s.settings.data.theme);
  const accentColor = useAppSelector((s) => s.settings.data.accent_color);
  const accentGradient = useAppSelector((s) => s.settings.data.accent_gradient);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const settled = useAppSelector((s) => s.settings.settled);
  const allowExperimentalUpdates = useAppSelector((s) => s.settings.data.allow_experimental_updates);
  useEffect(() => {
    dispatch(fetchSettings());
    dispatch(fetchModels());
    // Boot race (ENG-207): the renderer can beat the backend up by many seconds, and a hidden
    // window's timers get App-Napped, so a one-shot fetch that lost the race stayed lost until a
    // manual reload. Retry the two bootstrap reads until settings answer, and re-kick on focus /
    // visibility so a napped window heals the moment anyone looks at it.
    let bootTimer: ReturnType<typeof setInterval> | null = null;
    const bootRetry = () => {
      const st = store.getState();
      const settingsOk = st.settings.loaded;
      const modelsOk = st.models.loaded && !st.models.failed;
      if (settingsOk && modelsOk) {
        if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
        return;
      }
      if (!settingsOk) dispatch(fetchSettings());
      if (!modelsOk) dispatch(fetchModels());
    };
    bootTimer = setInterval(bootRetry, 3000);
    window.addEventListener('focus', bootRetry);
    document.addEventListener('visibilitychange', bootRetry);
    // Report the app launch with the browser's canonical tz/locale so the backend can emit analytics app_lifecycle.opened with values that work in packaged, dev, and open-source builds. Guarded once per page load; backend dedupes per process.
    reportAppOpened();
    // Connected subscriptions live in their own slice; without this the dashboard (and the onboarding gate) think no model is connected until the user opens Settings > Models, so a fresh launch shows a false "connect a model" empty state and the welcome cursor never fires. Refetched after sync + on focus below.
    dispatch(fetchSubscriptionStatus());
    fetch(`${API_BASE}/subscription/sync`, { method: 'POST' })
      .then((r) => {
        if (r.ok) dispatch(fetchSettings());
      })
      .catch(() => {})
      .finally(() => {
        // The free tier is retired. Nothing arms it any more, so there is no mint on boot; the flag
        // still settles so the "connect a model" banner is not held back waiting for a call that
        // will never happen.
        dispatch(markFreeTrialArmSettled());
      });
    return () => {
      if (bootTimer) clearInterval(bootTimer);
      window.removeEventListener('focus', bootRetry);
      document.removeEventListener('visibilitychange', bootRetry);
    };
  }, [dispatch]);

  useEffect(() => {
    const onFocus = () => { dispatch(fetchSettings()); dispatch(fetchSubscriptionStatus()); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [dispatch]);

  // 9Router starts in the BACKGROUND now, so the boot fetches above can land while it's still coming up: /models omits subscription models and /subscriptions/status reports nothing connected, leaving the picker empty and a real sub looking disconnected. The only other re-sync is window 'focus', which never fires on a window that's already focused at launch, so it used to stay broken until a manual Cmd+Shift+R. Re-pull models + status until 9Router answers (running), capped so a machine where it never comes up doesn't poll forever.
  const nineRouterUp = useAppSelector((s) => s.subscriptions.status?.running === true);
  useEffect(() => {
    if (nineRouterUp) {
      // 9Router answered, but its provider list (/api/providers) can lag is_running by a beat on a cold start, so the fetch that flipped us 'up' may still be missing subscription rows. Two bounded follow-up pulls catch them, then we stop. When there's genuinely no sub this is just a couple of cheap localhost GETs, never a wait on something that doesn't exist.
      const t1 = window.setTimeout(() => { dispatch(fetchSubscriptionStatus()); dispatch(fetchModels()); }, 1500);
      const t2 = window.setTimeout(() => { dispatch(fetchSubscriptionStatus()); dispatch(fetchModels()); }, 3500);
      return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    }
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      dispatch(fetchSubscriptionStatus());
      dispatch(fetchModels());
      if (ticks >= 30) window.clearInterval(id);
    }, 1500);
    return () => window.clearInterval(id);
  }, [nineRouterUp, dispatch]);

  useEffect(() => {
    if (loaded) setThemeMode(theme as 'light' | 'dark');
  }, [loaded, theme, setThemeMode]);

  // Effect re-fires only when the persisted value changes, so live pad drags (context-only until finish() patches) never get snapped back by a mid-drag settings refetch.
  useEffect(() => {
    if (loaded) setAccent(accentColor ?? null);
  }, [loaded, accentColor, setAccent]);

  // Object identity churns on every settings fetch, so key the effect on the serialized stops.
  const gradientKey = JSON.stringify(accentGradient ?? null);
  useEffect(() => {
    if (loaded) setGradient(accentGradient ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, gradientKey, setGradient]);

  useEffect(() => {
    if (!loaded) return;
    (window as any).openswarm?.setAllowPrerelease?.(allowExperimentalUpdates);
  }, [loaded, allowExperimentalUpdates]);
  useEffect(() => installUxSignals(), []);
  // Hold paint until the settings fetch SETTLES so the user's theme renders first; Electron's ready-to-show relies on this. Settling, not succeeding: a backend that never answers used to leave a blank window forever.
  if (!settled) return null;
  return <>{children}</>;
};

const DEFAULT_MODEL_PRIORITY: string[] = [
  'Anthropic',
  'OpenAI',
  'Google',
  'OpenSwarm Pro',
  'OpenSwarm',
];

const DEFAULT_MODEL_PICKS: Record<string, string[]> = {
  Anthropic: ['opus-5-cc', 'opus-5', 'opus-5-api', 'sonnet-5-cc', 'sonnet-5'],
  OpenAI: ['gpt-5.6', 'gpt-5.6-api', 'gpt-5.5', 'gpt-5.5-api'],
  Google: ['gemini-3.6-flash-api', 'gemini-3.5-flash-api', 'gemini-3.1-flash-lite'],
  'OpenSwarm Pro': ['sonnet', 'opus'],
  OpenSwarm: ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-4.1'],
};

function pickFallbackModel(
  byProvider: Record<string, Array<{ value: string; label: string }>>,
): { value: string; label: string; provider: string } | null {
  for (const prov of DEFAULT_MODEL_PRIORITY) {
    const models = byProvider[prov];
    if (!models || models.length === 0) continue;
    const available = new Map(models.map((m) => [m.value, m]));
    const picks = DEFAULT_MODEL_PICKS[prov] || [];
    for (const candidate of picks) {
      const m = available.get(candidate);
      if (m) return { value: m.value, label: m.label, provider: prov };
    }
    const first = models[0];
    return { value: first.value, label: first.label, provider: prov };
  }
  return null;
}

/** Reconciles stored default_model against reachable models; falls back per DEFAULT_MODEL_PRIORITY and warns once. */
const DefaultModelGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const byProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);
  // Until 9Router answers, /models omits subscription models, so the saved default can look "no longer available" when it's really just not loaded yet. Reconciling then would clobber a real sub user's default down to a fallback (and persist it). Only reconcile against the complete list.
  const nineRouterUp = useAppSelector((s) => s.subscriptions.status?.running === true);
  // A primitive fingerprint, not the sessions map: subscribing the app ROOT to whole sessions re-rendered it on every stream tick; this only changes when some session's MODEL changes.
  const sessionModelsKey = useAppSelector((s) => Object.values(s.agents.sessions).map((x) => x.model || '').join('|'));
  const connectionMode = useAppSelector((s) => s.settings.data.connection_mode);
  const freeTrialRemaining = useAppSelector((s) => s.settings.data.free_trial_remaining);

  const c = useClaudeTokens();
  const [sessionSwitch, setSessionSwitch] = useState<{ toFreeTrial: boolean; runs: number | null; toLabel: string } | null>(null);
  const pendingRef = useRef(false);
  // Sessions already announced, so a poll that re-hydrates a dead model cannot re-nag.
  const warnedSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!settingsLoaded || !modelsLoaded || !nineRouterUp) return;
    if (pendingRef.current) return;
    if (Object.keys(byProvider).length === 0) return;

    const flat = Object.values(byProvider).flat();
    const currentExists = flat.some((m) => m.value === settings.default_model);
    if (currentExists) return;

    // Nothing real connected means the synthesized free row is the whole list; persisting it would brand haiku as the user's default forever (ENG-343).
    if (!flat.some((m) => m.billing_kind !== 'free')) return;

    const fallback = pickFallbackModel(byProvider);
    if (!fallback || fallback.value === settings.default_model) return;

    // Persist the fallback so the stored default is never a dead model, and surface the same blue banner the per-session reconcile uses (no separate yellow notice, it just doubled up).
    pendingRef.current = true;
    dispatch(updateSettingsPatch({ default_model: fallback.value }))
      .finally(() => {
        pendingRef.current = false;
      });
    setSessionSwitch({ toFreeTrial: connectionMode === 'free-trial', runs: freeTrialRemaining ?? null, toLabel: fallback.label });
  }, [settingsLoaded, modelsLoaded, nineRouterUp, connectionMode, freeTrialRemaining, byProvider, settings, dispatch]);

  // Same staleness per session: a session pinned to a now-gone model (e.g. gpt-5.4-api after its key is disconnected) snags on the next send since the send carries that model, so reconcile open sessions to the valid default/fallback and warn once.
  useEffect(() => {
    if (!settingsLoaded || !modelsLoaded) return;
    // free-trial/pro model lists don't wait on 9Router sub enumeration, so don't gate them on nineRouterUp (often false on the free lane) or a stranded session never recovers.
    if (!nineRouterUp && connectionMode !== 'free-trial' && connectionMode !== 'openswarm-pro') return;
    if (Object.keys(byProvider).length === 0) return;
    const flat = Object.values(byProvider).flat();
    const valid = new Set(flat.map((m) => m.value));
    if (valid.size === 0) return;
    const fallback = pickFallbackModel(byProvider);
    if (!fallback) return;
    const target = valid.has(settings.default_model) ? settings.default_model : fallback.value;
    let switched = false;
    for (const sess of Object.values(store.getState().agents.sessions)) {
      if (sess.model && !valid.has(sess.model)) {
        // The switch is store-only, and the metadata poll re-hydrates the dead model from disk every
        // few seconds, so re-announcing meant the banner returned forever for anyone holding a chat
        // pinned to a retired model. Fix it every time (the next send must carry a live model), tell
        // them once.
        if (!warnedSessionsRef.current.has(sess.id)) {
          warnedSessionsRef.current.add(sess.id);
          switched = true;
        }
        dispatch(updateSessionModel({ sessionId: sess.id, model: target }));
        // Write it through, or the poll re-hydrates the dead model and we are back here next tick.
        void dispatch(persistSessionModel({ sessionId: sess.id, model: target }));
      }
    }
    if (switched) {
      const toLabel = flat.find((m) => m.value === target)?.label ?? target;
      setSessionSwitch({ toFreeTrial: connectionMode === 'free-trial', runs: freeTrialRemaining ?? null, toLabel });
    }
  }, [settingsLoaded, modelsLoaded, nineRouterUp, connectionMode, freeTrialRemaining, byProvider, sessionModelsKey, settings, dispatch]);

  return (
    <>
      {children}
      {/* Same glass pill the reconnecting toast uses. This was a raw MUI filled Alert, i.e. stock
          Material blue on an app with none of it anywhere else, and it sat at the same bottom-centre
          spot as that pill so the two stacked into one crowded blue block. Sits above it. */}
      <Snackbar
        open={!!sessionSwitch}
        autoHideDuration={9000}
        onClose={() => setSessionSwitch(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 72, sm: 72 } }}
      >
        <Box
          sx={{
            display: 'flex', alignItems: 'center', gap: 1, px: 1.75, py: 1, borderRadius: 999,
            background: c.bg.elevated, border: `1px solid ${c.border.strong}`, boxShadow: c.shadow.lg,
          }}
        >
          <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, fontWeight: 500 }}>
            {sessionSwitch && (sessionSwitch.toFreeTrial ? (
              <>Your model isn't connected, you're on the free trial now{sessionSwitch.runs != null ? <> ({sessionSwitch.runs} runs left)</> : null}.</>
            ) : (
              <>Switched to <b>{sessionSwitch.toLabel}</b>, your previous model is no longer available.</>
            ))}
          </Typography>
          <Box
            component="button"
            aria-label="Dismiss"
            onClick={() => setSessionSwitch(null)}
            sx={{
              border: 'none', background: 'transparent', cursor: 'pointer', p: 0, ml: 0.5,
              fontSize: '1rem', lineHeight: 1, color: c.text.tertiary,
              '&:hover': { color: c.text.primary },
            }}
          >
            &times;
          </Box>
        </Box>
      </Snackbar>
    </>
  );
};

/** Surfaces a brief recovery chip if the crash-watchdog relaunched us last cycle.
 *  Mac-only path (watchdog only runs on darwin); main.js returns null elsewhere.
 *  Fade in over 250ms, hold for 8s, fade out over 300ms. No interaction required;
 *  sessions are server-side so reattachment is automatic. */
const CrashRecoveryChip: React.FC = () => {
  const [show, setShow] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    const api = (window as any).openswarm as OpenSwarmAPI | undefined;
    if (!api?.getCrashRecoveryInfo) return;
    api.getCrashRecoveryInfo().then((info) => {
      if (info) {
        setMounted(true); setShow(true);
        // The crash was captured locally but analytics never heard about it; a silent GPU/renderer
        // death is exactly the failure class telemetry must count (flight-recorder family A).
        const i = info as { kind?: string; details?: { reason?: string; exitCode?: number } };
        report('process', 'crash_recovered', {
          crash_kind: i.kind ?? 'unknown',
          reason: i.details?.reason ?? null,
          exit_code: i.details?.exitCode ?? null,
        });
      }
    }).catch(() => {});
  }, []);
  React.useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), 8000);
    return () => clearTimeout(t);
  }, [show]);
  if (!mounted) return null;
  return (
    <Fade in={show} timeout={{ enter: 250, exit: 300 }} unmountOnExit>
      <Box sx={{
        position: 'fixed', top: 16, right: 16, zIndex: 1500,
        display: 'flex', alignItems: 'center', gap: 1,
        bgcolor: 'background.paper',
        border: '1px solid', borderColor: 'divider',
        boxShadow: 3, borderRadius: '10px',
        px: 1.75, py: 1, fontSize: '0.875rem',
        maxWidth: 360,
      }}>
        <Box component="span" sx={{
          width: 8, height: 8, borderRadius: '50%',
          bgcolor: 'success.main',
        }} />
        <Box component="span">
          We had a hiccup and brought you back. Your sessions are still here.
        </Box>
      </Box>
    </Fade>
  );
};

const UpdateListener: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const api = (window as any).openswarm as OpenSwarmAPI | undefined;
    if (!api?.getAppVersion) return;

    api.getAppVersion().then((v: string) => dispatch(setAppVersion(v)));

    api.getUpdateStatus?.().then((cached) => {
      if (!cached) return;
      if (cached.status === 'available' && cached.info?.version) {
        dispatch(setUpdateAvailable(cached.info.version));
      } else if (cached.status === 'not-available') {
        dispatch(setUpdateNotAvailable());
      } else if (cached.status === 'downloading' && cached.info?.percent != null) {
        dispatch(setDownloading(cached.info.percent));
      } else if (cached.status === 'downloaded') {
        dispatch(setUpdateDownloaded());
      } else if (cached.status === 'error' && cached.error) {
        dispatch(setUpdateError(cached.error));
      }
    });

    const cleanups = [
      api.onUpdateAvailable?.((info: OpenSwarmUpdateInfo) => dispatch(setUpdateAvailable(info.version))),
      api.onUpdateNotAvailable?.(() => dispatch(setUpdateNotAvailable())),
      api.onDownloadProgress?.((p: OpenSwarmDownloadProgress) => dispatch(setDownloading(p.percent))),
      api.onUpdateDownloaded?.(() => dispatch(setUpdateDownloaded())),
      api.onUpdateError?.((msg: string) => dispatch(setUpdateError(msg))),
    ];

    return () => cleanups.forEach((fn: (() => void) | undefined) => fn?.());
  }, [dispatch]);

  return <>{children}</>;
};

const ThemedApp: React.FC = () => {
  const c = useClaudeTokens();
  const { mode } = useThemeMode();
  const muiTheme = useMemo(() => buildMuiTheme(c, mode), [c, mode]);

  useEffect(() => {
    const handleUnload = () => {
      const { appStartTs, currentPage } = getSessionTraceState();
      report('app', 'last_action', {
        last_page: currentPage,
        time_spent_seconds: Math.round((Date.now() - appStartTs) / 1000),
      }, { immediate: true });
    };
    const handleError = (event: ErrorEvent) => {
      const { currentPage } = getSessionTraceState();
      report('app', 'error', {
        error_message: event.message,
        error_stack: event.error?.stack?.slice(0, 500),
        last_page: currentPage,
        recent_actions: getRecentActions(10),
      });
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('error', handleError);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('error', handleError);
    };
  }, []);

  return (
    <MuiThemeProvider theme={muiTheme}>
      <CssBaseline />
      <HashRouter>
        <RouteTrackerMount />
        <SettingsLoader>
            <DefaultModelGuard>
            <UpdateListener>
              <CrashRecoveryChip />
              <ImportEntryPoint />
              <DeepLinkListener>
                <ErrorBoundary scope="routes">
                  <Suspense fallback={null}>
                    <Routes>
                      <Route element={<AppShell />}>
                        <Route path="/" element={<DashboardAutoEnter />} />
                        {/* Dashboard renders persistently in AppShell so webviews survive nav. */}
                        <Route path="/dashboard/:id" element={null} />
                        <Route path="/analytics" element={<Analytics />} />
                      </Route>
                    </Routes>
                  </Suspense>
                </ErrorBoundary>
                <OnboardingErrorGuard>
                  <Suspense fallback={null}>
                    <OnboardingRoot />
                  </Suspense>
                </OnboardingErrorGuard>
                <OnboardingErrorGuard>
                  <Suspense fallback={null}>
                    <OnboardingV3Root />
                  </Suspense>
                </OnboardingErrorGuard>
                <Suspense fallback={null}>
                  <SignInRequiredGate />
                </Suspense>
              </DeepLinkListener>
            </UpdateListener>
            </DefaultModelGuard>
          </SettingsLoader>
      </HashRouter>
    </MuiThemeProvider>
  );
};

/**
 * Onboarding must never be able to take the whole app down. It mounts beside the
 * routes (not under them), so before this guard a render throw bubbled to the root
 * boundary and blanked everything. Here we catch it locally: keep the dashboard
 * alive (fallback null), report it under its own scope so the stack finally shows
 * up in telemetry, and dismiss the tour in storage so the next launch doesn't drop
 * the user straight back into the same crash. Settings > restart tour re-enables it.
 */
const OnboardingErrorGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  return (
    <ErrorBoundary
      scope="onboarding"
      fallback={null}
      onError={() => {
        try { dispatch(setPanelMode('hidden')); } catch {}
        disableOnboardingAfterCrash();
      }}
    >
      {children}
    </ErrorBoundary>
  );
};

// useRouteTracker calls useLocation, must be inside HashRouter.
const RouteTrackerMount: React.FC = () => {
  useRouteTracker();
  return null;
};

const Main: React.FC = () => {
  return (
    <Provider store={store}>
      <ThemeProvider>
        <ThemedApp />
      </ThemeProvider>
    </Provider>
  );
};

export default Main;
