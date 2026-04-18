import React, { useMemo, useEffect } from 'react';
import { Provider } from 'react-redux';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider as MuiThemeProvider, CssBaseline } from '@mui/material';
import { store } from '../shared/state/store';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { GET_SETTINGS } from '@/shared/backend-bridge/apps/settings';
import { SUBSCRIPTIONS_STATUS } from '@/shared/backend-bridge/apps/subscriptions';
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
import Skills from './pages/Skills/Skills';
import Tools from './pages/Tools/Tools';
import Modes from './pages/Modes/Modes';
import Views from './pages/Views/Views';
import Customization from './pages/Customization/Customization';
import OnboardingModal from './components/OnboardingModal';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import KeyboardShortcutsHelp from './components/KeyboardShortcutsHelp';
import { ThemeProvider, useThemeMode, useClaudeTokens } from '@/shared/styles/ThemeContext';
import { buildMuiTheme } from './buildMuiTheme';

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
    dispatch(GET_SETTINGS());
    dispatch(SUBSCRIPTIONS_STATUS());
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
                  <Route path="/skills" element={<Skills />} />
                  <Route path="/actions" element={<Tools />} />
                  <Route path="/modes" element={<Modes />} />
                  <Route path="/apps" element={<Views />} />
                  <Route path="/apps/:id" element={<Views />} />
                </Route>
              </Routes>
              <OnboardingModal />
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
