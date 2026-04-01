import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { ClaudeTokens, ThemeName, THEMES } from './claudeTokens';

interface ThemeContextValue {
  theme: ThemeName;
  mode: 'light' | 'dark';
  tokens: ClaudeTokens;
  radiusScale: number;
  setTheme: (theme: ThemeName) => void;
  setRadiusScale: (scale: number) => void;
  /** @deprecated use setTheme() */
  toggleMode: () => void;
  /** @deprecated use setTheme() */
  setMode: (mode: 'light' | 'dark') => void;
}

const THEME_KEY = 'openswarm-theme';
const RADIUS_KEY = 'openswarm-radius-scale';

/** Coerce any string (including legacy 'dark'/'light') to a valid ThemeName. */
function coerceTheme(raw: string | null | undefined): ThemeName | null {
  if (!raw) return null;
  if (raw in THEMES) return raw as ThemeName;
  if (raw === 'dark') return 'midnight';
  if (raw === 'light') return 'light';
  return null;
}

function getInitialTheme(): ThemeName {
  try {
    const t =
      coerceTheme(localStorage.getItem(THEME_KEY)) ??
      coerceTheme(localStorage.getItem('self-swarm-theme-mode'));
    if (t) return t;
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'midnight' : 'light';
}

function getInitialScale(): number {
  try {
    const s = parseFloat(localStorage.getItem(RADIUS_KEY) ?? '');
    if (!isNaN(s) && s >= 0) return s;
  } catch {}
  return 1.0;
}

/** Apply a scale multiplier to all radius values (full stays fixed). */
export function scaleRadii(
  base: ClaudeTokens['radius'],
  scale: number,
): ClaudeTokens['radius'] {
  return {
    xs: Math.round(base.xs * scale),
    sm: Math.round(base.sm * scale),
    md: Math.round(base.md * scale),
    lg: Math.round(base.lg * scale),
    xl: Math.round(base.xl * scale),
    full: base.full,
  };
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'midnight',
  mode: 'dark',
  tokens: THEMES.midnight.tokens,
  radiusScale: 1.0,
  setTheme: () => {},
  setRadiusScale: () => {},
  toggleMode: () => {},
  setMode: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeName>(getInitialTheme);
  const [radiusScale, setScaleState] = useState<number>(getInitialScale);

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(RADIUS_KEY, String(radiusScale)); } catch {}
  }, [radiusScale]);

  const meta = useMemo(() => THEMES[theme] ?? THEMES.midnight, [theme]);
  const mode: 'light' | 'dark' = meta.dark ? 'dark' : 'light';

  const tokens = useMemo<ClaudeTokens>(() => ({
    ...meta.tokens,
    radius: scaleRadii(meta.tokens.radius, radiusScale),
  }), [meta, radiusScale]);

  const setTheme = (t: ThemeName) => {
    const safe = coerceTheme(t as string) ?? 'midnight';
    setThemeState(safe);
  };

  const setRadiusScale = (s: number) => setScaleState(Math.max(0, s));

  const setMode = (m: 'light' | 'dark') => setThemeState(m === 'dark' ? 'midnight' : 'light');
  const toggleMode = () => setThemeState((t) => (THEMES[t].dark ? 'light' : 'midnight'));

  const value = useMemo(
    () => ({ theme, mode, tokens, radiusScale, setTheme, setRadiusScale, toggleMode, setMode }),
    [theme, mode, tokens, radiusScale],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useClaudeTokens = (): ClaudeTokens => useContext(ThemeContext).tokens;
export const useTheme = () => useContext(ThemeContext);
export const useThemeMode = () => {
  const { mode, toggleMode, setMode } = useContext(ThemeContext);
  return { mode, toggleMode, setMode };
};
