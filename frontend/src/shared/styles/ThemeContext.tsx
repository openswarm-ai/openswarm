import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { ClaudeTokens, lightTokens, darkTokens } from './claudeTokens';

type ThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  tokens: ClaudeTokens;
  toggleMode: () => void;
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'self-swarm-theme-mode';

function getInitialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  tokens: lightTokens,
  toggleMode: () => {},
  setMode: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  }, [mode]);

  const tokens = useMemo(() => (mode === 'dark' ? darkTokens : lightTokens), [mode]);

  const toggleMode = () => setModeState((m) => (m === 'light' ? 'dark' : 'light'));
  const setMode = (m: ThemeMode) => setModeState(m);

  const value = useMemo(() => ({ mode, tokens, toggleMode, setMode }), [mode, tokens]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useClaudeTokens = (): ClaudeTokens => useContext(ThemeContext).tokens;
export const useThemeMode = () => {
  const { mode, toggleMode, setMode } = useContext(ThemeContext);
  return { mode, toggleMode, setMode };
};
