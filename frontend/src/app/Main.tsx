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
import ErrorBoundary from './components/feedback/ErrorBoundary';
import { setPanelMode, disableOnboardingAfterCrash } from '@/shared/state/onboardingProgressSlice';
const Skills = lazy(() => import('./pages/Skills/Skills'));
const Tools = lazy(() => import('./pages/Tools/Tools'));
const Modes = lazy(() => import('./pages/Modes/Modes'));
const Views = lazy(() => import('./pages/Views/Views'));
const Customization = lazy(() => import('./pages/Customization/Customization'));
const Analytics = lazy(() => import('./pages/Analytics/Analytics'));
const OnboardingRoot = lazy(() =>
  import('./components/Onboarding').then((m) => ({ default: m.OnboardingRoot })),
);
const SignInGate = lazy(() => import('./components/overlays/SignInGate'));

if (typeof window !== 'undefined') {
  (window as any).__openswarmPrefetchRoute = (path: string) => {
    switch (path) {
      case '/skills': void import('./pages/Skills/Skills'); return;
      case '/actions':
      case '/tools': void import('./pages/Tools/Tools'); return;
      case '/modes': void import('./pages/Modes/Modes'); return;
      case '/views':
      case '/apps': void import('./pages/Views/Views'); return;
      case '/customization': void import('./pages/Customization/Customization'); return;
      case '/analytics': void import('./pages/Analytics/Analytics'); return;
    }
  };
  const prefetchAll = () => {
    void import('./pages/Views/Views');
    void import('./pages/Skills/Skills');
    void import('./pages/Tools/Tools');
    void import('./pages/Modes/Modes');
    void import('./pages/Customization/Customization');
    void import('./pages/Analytics/Analytics');
  };
  const ric = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout?: number }) => number)
    | undefined;
  if (ric) ric(prefetchAll, { timeout: 1500 });
  else window.setTimeout(prefetchAll, 500);
}
import { report, getSessionTraceState, getRecentActions } from '@/shared/serviceClient';
import { useRouteTracker } from '@/shared/hooks/useRouteTracker';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useDeepLink } from '@/shared/hooks/useDeepLink';
import { useWindowFocus } from '@/shared/hooks/useWindowFocus';
import { useInteractionHeartbeat } from '@/shared/hooks/useInteractionHeartbeat';
import KeyboardShortcutsHelp from './components/overlays/KeyboardShortcutsHelp';
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
  useWindowFocus();
  useInteractionHeartbeat();
  return <>{children}</>;
};

const SettingsLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const { setMode: setThemeMode } = useThemeMode();
  const theme = useAppSelector((s) => s.settings.data.theme);
  const loaded = useAppSelector((s) => s.settings.loaded);
  const allowExperimentalUpdates = useAppSelector((s) => s.settings.data.allow_experimental_updates);
  useEffect(() => {
    dispatch(fetchSettings());
    dispatch(fetchModels());
    fetch(`${API_BASE}/subscription/sync`, { method: 'POST' })
      .then((r) => {
        if (r.ok) dispatch(fetchSettings());
      })
      .catch(() => {});
  }, [dispatch]);

  useEffect(() => {
    const onFocus = () => { dispatch(fetchSettings()); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [dispatch]);

  useEffect(() => {
    if (loaded) setThemeMode(theme as 'light' | 'dark');
  }, [loaded, theme, setThemeMode]);

  useEffect(() => {
    if (!loaded) return;
    (window as any).openswarm?.setAllowPrerelease?.(allowExperimentalUpdates);
  }, [loaded, allowExperimentalUpdates]);
  return <>{children}</>;
};

/** Mandatory sign-in gate; first thing shown when settings lack a user_id or bearer. */
const SignInGateLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);

  const alreadySignedIn = Boolean(settings.user_id || settings.openswarm_bearer_token);

  useEffect(() => {
    if (!settingsLoaded || alreadySignedIn) return;
    const id = setInterval(() => { dispatch(fetchSettings()); }, 2000);
    return () => clearInterval(id);
  }, [dispatch, settingsLoaded, alreadySignedIn]);

  if (!settingsLoaded) return null;
  if (alreadySignedIn) return <>{children}</>;

  return (
    <>
      {children}
      <Suspense fallback={null}>
        <SignInGate />
      </Suspense>
    </>
  );
};

const DEFAULT_MODEL_PRIORITY: string[] = [
  'Anthropic',
  'OpenAI',
  'Google',
  'OpenSwarm Pro',
  'OpenSwarm',
];

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

/** Reconciles stored default_model against reachable models; falls back per DEFAULT_MODEL_PRIORITY and warns once. */
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
            <>Default model <b>{warning.from}</b> is no longer available, switched to <b>{warning.to}</b> ({warning.provider}).</>
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
                        {/* Dashboard renders persistently in AppShell so webviews survive nav. */}
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
                <OnboardingErrorGuard>
                  <Suspense fallback={null}>
                    <OnboardingRoot />
                  </Suspense>
                </OnboardingErrorGuard>
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
