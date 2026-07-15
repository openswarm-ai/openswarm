import React, { createContext, useContext, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ClaudeTokens, lightTokens, darkTokens, withAccent } from './claudeTokens';

type ThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  tokens: ClaudeTokens;
  accent: string | null;
  gradient: string[] | null;
  washOpacity: number;
  grain: number;
  toggleMode: () => void;
  setMode: (mode: ThemeMode) => void;
  setAccent: (hex: string | null) => void;
  setGradient: (stops: string[] | null) => void;
  setWashOpacity: (v: number) => void;
  setGrain: (v: number) => void;
}

const STORAGE_KEY = 'self-swarm-theme-mode';
const ACCENT_STORAGE_KEY = 'self-swarm-theme-accent';
const GRADIENT_STORAGE_KEY = 'self-swarm-theme-gradient';
const WASH_OPACITY_KEY = 'self-swarm-theme-wash-opacity';
const GRAIN_KEY = 'self-swarm-theme-grain';
export const DEFAULT_WASH_OPACITY = 0.17;

function getInitialNum(key: string, def: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  } catch {}
  return def;
}

function getInitialGradient(): string[] | null {
  try {
    const stored = JSON.parse(localStorage.getItem(GRADIENT_STORAGE_KEY) ?? 'null');
    if (Array.isArray(stored) && stored.length > 1 && stored.every((v) => /^#[0-9a-f]{6}$/i.test(v))) return stored;
  } catch {}
  return null;
}

function getInitialAccent(): string | null {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (stored && /^#[0-9a-f]{6}$/i.test(stored)) return stored;
  } catch {}
  return null;
}

function getInitialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  // Default light regardless of OS; the real choice arrives from settings a beat later, and matching that default here keeps the pre-load frame from flashing to the opposite theme.
  return 'light';
}

// A theme swap repaints every element, and the app's hover transitions (transition: background-color / all) would each crossfade the new color at their own duration: that staggered animation IS the flicker. Kill all transitions for the single swap frame so the change is one instant cut; hovers animate again next tick.
function p_suppressTransitionsForSwap(): () => void {
  const killer = document.createElement('style');
  killer.appendChild(document.createTextNode('*,*::before,*::after{transition:none!important}'));
  document.head.appendChild(killer);
  void document.body.offsetHeight; // force a synchronous restyle so the rule applies to this frame
  const id = window.setTimeout(() => killer.remove(), 0);
  return () => { window.clearTimeout(id); killer.remove(); };
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  tokens: lightTokens,
  accent: null,
  gradient: null,
  washOpacity: DEFAULT_WASH_OPACITY,
  grain: 0,
  toggleMode: () => {},
  setMode: () => {},
  setAccent: () => {},
  setGradient: () => {},
  setWashOpacity: () => {},
  setGrain: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const [accent, setAccentState] = useState<string | null>(getInitialAccent);
  const [gradient, setGradientState] = useState<string[] | null>(getInitialGradient);
  const [washOpacity, setWashOpacityState] = useState<number>(() => getInitialNum(WASH_OPACITY_KEY, DEFAULT_WASH_OPACITY));
  const [grain, setGrainState] = useState<number>(() => getInitialNum(GRAIN_KEY, 0));
  const firstMount = useRef(true);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
    if (firstMount.current) { firstMount.current = false; return; }
    return p_suppressTransitionsForSwap();
  }, [mode]);

  // No transition suppression here: accent changes stream continuously while the onboarding pad is dragged, and killing transitions per frame would fight the drag.
  useEffect(() => {
    try {
      if (accent) localStorage.setItem(ACCENT_STORAGE_KEY, accent);
      else localStorage.removeItem(ACCENT_STORAGE_KEY);
    } catch {}
  }, [accent]);

  useEffect(() => {
    try {
      if (gradient) localStorage.setItem(GRADIENT_STORAGE_KEY, JSON.stringify(gradient));
      else localStorage.removeItem(GRADIENT_STORAGE_KEY);
    } catch {}
  }, [gradient]);

  useEffect(() => { try { localStorage.setItem(WASH_OPACITY_KEY, String(washOpacity)); } catch {} }, [washOpacity]);
  useEffect(() => { try { localStorage.setItem(GRAIN_KEY, String(grain)); } catch {} }, [grain]);

  const tokens = useMemo(() => withAccent(mode === 'dark' ? darkTokens : lightTokens, accent, mode), [mode, accent]);

  // Stable identities: SettingsLoader's "apply settings.theme" effect lists setMode in its deps, so a setter that changed every render made that effect re-fire on each toggle and re-assert the OLD persisted theme until the debounced save caught up: live theme snapped back for ~900ms = the switch flicker.
  const toggleMode = useCallback(() => setModeState((m) => (m === 'light' ? 'dark' : 'light')), []);
  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const setAccent = useCallback((hex: string | null) => setAccentState(hex), []);
  const setGradient = useCallback((stops: string[] | null) => setGradientState(stops), []);
  const setWashOpacity = useCallback((v: number) => setWashOpacityState(Math.min(1, Math.max(0, v))), []);
  const setGrain = useCallback((v: number) => setGrainState(Math.min(1, Math.max(0, v))), []);

  const value = useMemo(() => ({ mode, tokens, accent, gradient, washOpacity, grain, toggleMode, setMode, setAccent, setGradient, setWashOpacity, setGrain }), [mode, tokens, accent, gradient, washOpacity, grain, toggleMode, setMode, setAccent, setGradient, setWashOpacity, setGrain]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useClaudeTokens = (): ClaudeTokens => useContext(ThemeContext).tokens;
export const useThemeMode = () => {
  const { mode, toggleMode, setMode } = useContext(ThemeContext);
  return { mode, toggleMode, setMode };
};
export const useThemeAccent = () => {
  const { accent, setAccent, gradient, setGradient } = useContext(ThemeContext);
  return { accent, setAccent, gradient, setGradient };
};
export const useThemeWash = () => {
  const { washOpacity, grain, setWashOpacity, setGrain } = useContext(ThemeContext);
  return { washOpacity, grain, setWashOpacity, setGrain };
};
