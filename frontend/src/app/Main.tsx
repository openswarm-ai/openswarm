import React, { useMemo, useEffect, useState, useRef, Suspense, lazy } from 'react';
import { Provider } from 'react-redux';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider as MuiThemeProvider, createTheme, CssBaseline } from '@mui/material';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import { store } from '../shared/state/store';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchSettings, updateSettings } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
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
import DashboardSelection from './pages/DashboardSelection/DashboardSelection';
import ErrorBoundary from './components/ErrorBoundary';
// Lazy: heavy pages that aren't on the first-paint path.
const Skills = lazy(() => import('./pages/Skills/Skills'));
const Tools = lazy(() => import('./pages/Tools/Tools'));
const Modes = lazy(() => import('./pages/Modes/Modes'));
const Views = lazy(() => import('./pages/Views/Views'));
const Customization = lazy(() => import('./pages/Customization/Customization'));
const Analytics = lazy(() => import('./pages/Analytics/Analytics'));
const OnboardingModal = lazy(() => import('./components/OnboardingModal'));
const SignInGate = lazy(() => import('./components/SignInGate'));
import { report, getSessionTraceState, getRecentActions } from '@/shared/serviceClient';
import { useRouteTracker } from '@/shared/hooks/useRouteTracker';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useDeepLink } from '@/shared/hooks/useDeepLink';
import { useInteractionHeartbeat } from '@/shared/hooks/useInteractionHeartbeat';
import KeyboardShortcutsHelp from './components/KeyboardShortcutsHelp';
import { ThemeProvider, useThemeMode, useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

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

const ShortcutsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useKeyboardShortcuts();
  return <>{children}<KeyboardShortcutsHelp /></>;
};

const DeepLinkListener: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useDeepLink();
  // Single global interaction-timestamp recorder. Powers idle-dim and
  // similar UX, and gives the session-close dump a real "last user
  // interaction" timestamp.
  useInteractionHeartbeat();
  return <>{children}</>;
};

const SettingsLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const { setMode: setThemeMode } = useThemeMode();
  const theme = useAppSelector((s) => s.settings.data.theme);
  const loaded = useAppSelector((s) => s.settings.loaded);
  useEffect(() => {
    dispatch(fetchSettings());
    dispatch(fetchModels());
    // Reconcile OpenSwarm Pro state with Stripe on every launch so a
    // missed webhook (cancel, upgrade, renewal) can't leave the user
    // wedged on stale info. Fire-and-forget; if the cloud is unreachable
    // we simply keep whatever local state we already had.
    fetch(`${API_BASE}/subscription/sync`, { method: 'POST' })
      .then((r) => {
        if (r.ok) dispatch(fetchSettings());
      })
      .catch(() => { /* offline — next launch will reconcile */ });
  }, [dispatch]);
  useEffect(() => {
    if (loaded) setThemeMode(theme as 'light' | 'dark');
  }, [loaded, theme, setThemeMode]);
  return <>{children}</>;
};

// Sign-in gate. Sits between SettingsLoader and DefaultModelGuard so the
// gate is the very first thing a user without a user_id sees. Two modes:
//
//   - Hard gate (fresh installs, existing installs past the 30-day grace):
//     Modal blocks the app until sign-in completes. No skip link.
//   - Soft gate (existing installs inside the grace window): Modal can be
//     dismissed. settings.signin_skipped_until_ts persists "remind me in 7
//     days." On the next launch after that timestamp, the modal returns.
//
// Already-signed-in users (settings.user_id != null) skip the gate. Existing
// paid Stripe users without explicit sign-in also skip — their bearer is
// valid even though user_id might not have been backfilled yet (deferred
// to a one-time /api/me hit on the v1.0.30 first-launch). For the simple
// case we treat openswarm_bearer_token alone as "signed in" so paying
// customers never see the gate.
interface IdentityStatus {
  authed: boolean;
  hard_gate: boolean;
  install_age_days?: number;
  deadline_ts?: number | null;
}

const SignInGateLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const settings = useAppSelector((s) => s.settings.data);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [skipTs, setSkipTs] = useState<number>(0);

  // Already authenticated, either via the new sign-in flow (user_id set) or
  // a still-valid Stripe bearer (paid user upgrading from v1.0.29).
  const alreadySignedIn = Boolean(settings.user_id || settings.openswarm_bearer_token);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (alreadySignedIn) {
      setStatus({ authed: true, hard_gate: false });
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/auth/identity-status`)
      .then((r) => (r.ok ? r.json() : { authed: false, hard_gate: true }))
      .then((data) => {
        if (!cancelled) setStatus(data as IdentityStatus);
      })
      .catch(() => {
        // Cloud unreachable → fail open with soft gate so the user can keep
        // working. The gate will retry on next mount.
        if (!cancelled) setStatus({ authed: false, hard_gate: false });
      });
    return () => { cancelled = true; };
  }, [settingsLoaded, alreadySignedIn]);

  // Read the persisted "remind me later" timestamp from localStorage so
  // soft-gate skip survives reloads but doesn't bloat AppSettings.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('openswarm_signin_skipped_until');
      const n = raw ? parseInt(raw, 10) : 0;
      if (Number.isFinite(n)) setSkipTs(n);
    } catch { /* localStorage unavailable */ }
  }, []);

  if (!settingsLoaded || !status) return null;
  if (status.authed) return <>{children}</>;

  const skipActive = !status.hard_gate && Date.now() < skipTs;
  if (skipActive) return <>{children}</>;

  return (
    <>
      {children}
      <Suspense fallback={null}>
        <SignInGate
          softGate={!status.hard_gate}
          onSkip={() => {
            // 7-day reminder window for soft gate.
            const until = Date.now() + 7 * 24 * 60 * 60 * 1000;
            try {
              window.localStorage.setItem('openswarm_signin_skipped_until', String(until));
            } catch { /* ignore */ }
            setSkipTs(until);
          }}
        />
      </Suspense>
    </>
  );
};

// Priority order for picking a default model when the user's stored
// default_model is unreachable (no matching provider connected). The user's
// preferred fallback ordering: direct provider keys first, then OpenSwarm
// Pro, then Copilot-powered OpenSwarm free tier.
const DEFAULT_MODEL_PRIORITY: string[] = [
  'Anthropic',
  'OpenAI',
  'Google',
  'OpenSwarm Pro',
  'OpenSwarm',
];

// Preferred model pick inside each provider group. Ordered by the user's
// stated preference: Sonnet mid-tier for Claude, GPT-5.4 Mini for OpenAI,
// Flash for Gemini, and conservative picks for the shared tiers.
const DEFAULT_MODEL_PICKS: Record<string, string[]> = {
  Anthropic: ['sonnet-cc', 'sonnet'],
  OpenAI: ['gpt-5.4-mini', 'gpt-5.4'],
  Google: ['gemini-2.5-flash', 'gemini-3-flash', 'gemini-2.5-pro'],
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

// Reconciles the stored default_model against the set of models actually
// reachable given the user's current connections. When the stored value is
// unavailable, falls back per DEFAULT_MODEL_PRIORITY and shows a one-time
// warning so the user knows why their default changed.
const DefaultModelGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const byProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);

  const [warning, setWarning] = useState<{ from: string; to: string; provider: string } | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!settingsLoaded || !modelsLoaded) return;
    if (pendingRef.current) return;
    if (Object.keys(byProvider).length === 0) return;

    const flat = Object.values(byProvider).flat();
    const currentExists = flat.some((m) => m.value === settings.default_model);
    if (currentExists) return;

    const fallback = pickFallbackModel(byProvider);
    if (!fallback || fallback.value === settings.default_model) return;

    const fromLabel = flat.find((m) => m.value === settings.default_model)?.label ?? settings.default_model;
    pendingRef.current = true;
    dispatch(updateSettings({ ...settings, default_model: fallback.value }))
      .finally(() => {
        pendingRef.current = false;
      });
    setWarning({ from: fromLabel, to: fallback.label, provider: fallback.provider });
  }, [settingsLoaded, modelsLoaded, byProvider, settings, dispatch]);

  return (
    <>
      {children}
      <Snackbar
        open={!!warning}
        autoHideDuration={8000}
        onClose={() => setWarning(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity="warning"
          variant="filled"
          onClose={() => setWarning(null)}
          sx={{ fontSize: '0.8rem' }}
        >
          {warning && (
            <>Default model <b>{warning.from}</b> is no longer available — switched to <b>{warning.to}</b> ({warning.provider}).</>
          )}
        </Alert>
      </Snackbar>
    </>
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
        <ShortcutsProvider>
          <SettingsLoader>
            <SignInGateLoader>
            <DefaultModelGuard>
            <UpdateListener>
              <DeepLinkListener>
                <ErrorBoundary scope="routes">
                  <Suspense fallback={null}>
                    <Routes>
                      <Route element={<AppShell />}>
                        <Route path="/" element={<DashboardSelection />} />
                        {/* Dashboard route is a no-op stub — the actual <Dashboard /> is rendered
                            persistently inside AppShell so its webviews survive navigation between
                            routes. This route exists only so React Router matches the URL. */}
                        <Route path="/dashboard/:id" element={null} />
                        <Route path="/customization" element={<Customization />} />
                        <Route path="/skills" element={<Skills />} />
                        <Route path="/actions" element={<Tools />} />
                        <Route path="/modes" element={<Modes />} />
                        <Route path="/apps" element={<Views />} />
                        <Route path="/apps/:id" element={<Views />} />
                        <Route path="/analytics" element={<Analytics />} />
                      </Route>
                    </Routes>
                  </Suspense>
                </ErrorBoundary>
                <Suspense fallback={null}>
                  <OnboardingModal />
                </Suspense>
              </DeepLinkListener>
            </UpdateListener>
            </DefaultModelGuard>
            </SignInGateLoader>
          </SettingsLoader>
        </ShortcutsProvider>
      </HashRouter>
    </MuiThemeProvider>
  );
};

// Tiny mount-point so the route-tracker hook can use useLocation() (which
// requires a Router ancestor). Lives inside HashRouter, runs once.
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
