import React, { useMemo, useEffect } from 'react';
import { Provider } from 'react-redux';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider as MuiThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { store } from '../shared/state/store';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchSettings } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import {
  setAppVersion,
  setUpdateAvailable,
  setUpdateNotAvailable,
  setDownloading,
  setUpdateDownloaded,
  setUpdateError,
} from '@/shared/state/updateSlice';
import AppShell from './components/Layout/AppShell';
import Dashboard from './pages/Dashboard/Dashboard';
import DashboardSelection from './pages/DashboardSelection/DashboardSelection';
import Templates from './pages/Templates/Templates';
import Skills from './pages/Skills/Skills';
import Tools from './pages/Tools/Tools';
import Modes from './pages/Modes/Modes';
import Views from './pages/Views/Views';
import Customization from './pages/Customization/Customization';
import Channels from './pages/Channels/Channels';
import Analytics from './pages/Analytics/Analytics';
import AnalyticsOptIn from './components/AnalyticsOptIn';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
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

const SettingsLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useAppDispatch();
  const { setMode: setThemeMode } = useThemeMode();
  const theme = useAppSelector((s) => s.settings.data.theme);
  const loaded = useAppSelector((s) => s.settings.loaded);
  useEffect(() => {
    dispatch(fetchSettings());
    dispatch(fetchModels());
  }, [dispatch]);
  useEffect(() => {
    if (loaded) setThemeMode(theme as 'light' | 'dark');
  }, [loaded, theme, setThemeMode]);
  return <>{children}</>;
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

  return (
    <MuiThemeProvider theme={muiTheme}>
      <CssBaseline />
      <HashRouter>
        <ShortcutsProvider>
          <SettingsLoader>
            <UpdateListener>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/" element={<DashboardSelection />} />
                  <Route path="/dashboard/:id" element={<Dashboard />} />
                  <Route path="/customization" element={<Customization />} />
                  <Route path="/templates" element={<Templates />} />
                  <Route path="/skills" element={<Skills />} />
                  <Route path="/actions" element={<Tools />} />
                  <Route path="/modes" element={<Modes />} />
                  <Route path="/apps" element={<Views />} />
                  <Route path="/apps/:id" element={<Views />} />
                  <Route path="/channels" element={<Channels />} />
                  <Route path="/analytics" element={<Analytics />} />
                </Route>
              </Routes>
              <AnalyticsOptIn />
            </UpdateListener>
          </SettingsLoader>
        </ShortcutsProvider>
      </HashRouter>
    </MuiThemeProvider>
  );
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
