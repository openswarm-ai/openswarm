export interface ClaudeTokens {
  bg: { page: string; surface: string; elevated: string; secondary: string; inverse: string };
  text: { primary: string; secondary: string; tertiary: string; muted: string; inverse: string; ghost: string };
  accent: { primary: string; hover: string; pressed: string };
  border: { subtle: string; medium: string; strong: string; width: string };
  shadow: { sm: string; md: string; lg: string };
  radius: { xs: number; sm: number; md: number; lg: number; xl: number; full: number };
  status: { success: string; successBg: string; warning: string; warningBg: string; error: string; errorBg: string; info: string; infoBg: string };
  user: { bubble: string };
  font: { sans: string; mono: string };
  transition: string;
}

// ─── Midnight (default dark — warm charcoal, copper accent, Inter) ────────────
export const darkTokens: ClaudeTokens = {
  bg: {
    page: '#1a1918',
    surface: '#262624',
    elevated: '#30302E',
    secondary: '#1f1e1b',
    inverse: '#FAF9F5',
  },
  text: {
    primary: '#FAF9F5',
    secondary: '#C2C0B6',
    tertiary: '#9C9A92',
    muted: '#85837C',
    inverse: '#141413',
    ghost: 'rgba(156,154,146,0.5)',
  },
  accent: {
    primary: '#c4633a',
    hover: '#d47548',
    pressed: '#ae5630',
  },
  border: {
    subtle: 'rgba(222,220,209,0.08)',
    medium: 'rgba(222,220,209,0.12)',
    strong: 'rgba(222,220,209,0.2)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.2)',
    md: '0 4px 20px rgba(0,0,0,0.15)',
    lg: '0 8px 32px rgba(0,0,0,0.25)',
  },
  radius: { xs: 4, sm: 6, md: 10, lg: 14, xl: 18, full: 9999 },
  status: {
    success: '#7AB948', successBg: '#1B4614',
    warning: '#D1A041', warningBg: '#483A0F',
    error: '#DD5353',   errorBg: '#3D1515',
    info: '#80AADD',    infoBg: '#253E5F',
  },
  user: { bubble: '#393937' },
  font: {
    sans: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
};

// ─── Light (warm cream, copper accent, Inter) ─────────────────────────────────
export const lightTokens: ClaudeTokens = {
  bg: {
    page: '#F5F5F0',
    surface: '#FFFFFF',
    elevated: '#FAF9F5',
    secondary: '#F0EFE8',
    inverse: '#141413',
  },
  text: {
    primary: '#1a1a18',
    secondary: '#3D3D3A',
    tertiary: '#73726C',
    muted: '#6b6a68',
    inverse: '#FFFFFF',
    ghost: 'rgba(115,114,108,0.5)',
  },
  accent: {
    primary: '#ae5630',
    hover: '#c4633a',
    pressed: '#924828',
  },
  border: {
    subtle: 'rgba(0,0,0,0.06)',
    medium: 'rgba(0,0,0,0.09)',
    strong: 'rgba(0,0,0,0.16)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.04)',
    md: '0 4px 20px rgba(0,0,0,0.06)',
    lg: '0 8px 32px rgba(0,0,0,0.1)',
  },
  radius: { xs: 4, sm: 6, md: 10, lg: 14, xl: 18, full: 9999 },
  status: {
    success: '#265B19', successBg: '#E9F1DC',
    warning: '#805C1F', warningBg: '#F6EEDF',
    error: '#B53333',   errorBg: '#FEE2E2',
    info: '#3266AD',    infoBg: '#D6E4F6',
  },
  user: { bubble: '#DDD9CE' },
  font: {
    sans: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
};

// ─── Obsidian (near-black, ice-blue accent, Geist) ────────────────────────────
export const obsidianTokens: ClaudeTokens = {
  bg: {
    page: '#0c0c0c',
    surface: '#141414',
    elevated: '#1c1c1c',
    secondary: '#111111',
    inverse: '#F0F0F0',
  },
  text: {
    primary: '#EFEFEF',
    secondary: '#B0B0B0',
    tertiary: '#787878',
    muted: '#606060',
    inverse: '#0c0c0c',
    ghost: 'rgba(120,120,120,0.45)',
  },
  accent: {
    primary: '#7DAAFF',
    hover: '#96BBFF',
    pressed: '#6498EE',
  },
  border: {
    subtle: 'rgba(255,255,255,0.06)',
    medium: 'rgba(255,255,255,0.09)',
    strong: 'rgba(255,255,255,0.16)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 4px rgba(0,0,0,0.5)',
    md: '0 4px 24px rgba(0,0,0,0.4)',
    lg: '0 8px 40px rgba(0,0,0,0.55)',
  },
  radius: { xs: 3, sm: 5, md: 8, lg: 12, xl: 16, full: 9999 },
  status: {
    success: '#4ADE80', successBg: '#0D2E1A',
    warning: '#FBBF24', warningBg: '#2D2206',
    error: '#F87171',   errorBg: '#2D0F0F',
    info: '#60A5FA',    infoBg: '#0F1E35',
  },
  user: { bubble: '#1e1e1e' },
  font: {
    sans: '"Geist", "Inter", ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
};

// ─── Vapor (deep indigo-slate, violet accent, Inter) ──────────────────────────
export const vaporTokens: ClaudeTokens = {
  bg: {
    page: '#13121f',
    surface: '#1b1a2e',
    elevated: '#23223a',
    secondary: '#171626',
    inverse: '#F0EEFF',
  },
  text: {
    primary: '#EDE9FF',
    secondary: '#B8B0D8',
    tertiary: '#8A82A8',
    muted: '#736C90',
    inverse: '#13121f',
    ghost: 'rgba(138,130,168,0.4)',
  },
  accent: {
    primary: '#A78BFA',
    hover: '#BBA7FB',
    pressed: '#9270F0',
  },
  border: {
    subtle: 'rgba(167,139,250,0.1)',
    medium: 'rgba(167,139,250,0.15)',
    strong: 'rgba(167,139,250,0.28)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 4px rgba(0,0,0,0.35)',
    md: '0 4px 24px rgba(0,0,0,0.3)',
    lg: '0 8px 40px rgba(0,0,0,0.45)',
  },
  radius: { xs: 4, sm: 7, md: 12, lg: 16, xl: 20, full: 9999 },
  status: {
    success: '#6EE7B7', successBg: '#0D2B22',
    warning: '#FCD34D', warningBg: '#2B2007',
    error: '#FCA5A5',   errorBg: '#2B0F0F',
    info: '#93C5FD',    infoBg: '#0F1E35',
  },
  user: { bubble: '#252340' },
  font: {
    sans: '"Inter", ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
};

// ─── Aurora (dark forest, emerald accent, Plus Jakarta Sans) ──────────────────
export const auroraTokens: ClaudeTokens = {
  bg: {
    page: '#0e1812',
    surface: '#15221a',
    elevated: '#1c2e22',
    secondary: '#111d16',
    inverse: '#EDF7EF',
  },
  text: {
    primary: '#E6F4EA',
    secondary: '#A8C9AF',
    tertiary: '#72967A',
    muted: '#5E7D66',
    inverse: '#0e1812',
    ghost: 'rgba(114,150,122,0.45)',
  },
  accent: {
    primary: '#4ADE80',
    hover: '#65E896',
    pressed: '#34C468',
  },
  border: {
    subtle: 'rgba(74,222,128,0.1)',
    medium: 'rgba(74,222,128,0.16)',
    strong: 'rgba(74,222,128,0.28)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 4px rgba(0,0,0,0.3)',
    md: '0 4px 24px rgba(0,0,0,0.25)',
    lg: '0 8px 40px rgba(0,0,0,0.4)',
  },
  radius: { xs: 4, sm: 7, md: 12, lg: 16, xl: 20, full: 9999 },
  status: {
    success: '#4ADE80', successBg: '#0D2E1A',
    warning: '#FBBF24', warningBg: '#2D2206',
    error: '#F87171',   errorBg: '#2D0F0F',
    info: '#60A5FA',    infoBg: '#0F1E35',
  },
  user: { bubble: '#1a2e20' },
  font: {
    sans: '"Plus Jakarta Sans", "Inter", ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
};

// ─── Sand (warm light, amber accent, Plus Jakarta Sans) ───────────────────────
export const sandTokens: ClaudeTokens = {
  bg: {
    page: '#FAF6EF',
    surface: '#FFFFFF',
    elevated: '#FDF9F4',
    secondary: '#F2EDE3',
    inverse: '#1C1712',
  },
  text: {
    primary: '#1C1712',
    secondary: '#4A3F30',
    tertiary: '#7A6E60',
    muted: '#9A8E80',
    inverse: '#FAF6EF',
    ghost: 'rgba(122,110,96,0.4)',
  },
  accent: {
    primary: '#D97706',
    hover: '#F59E0B',
    pressed: '#B45309',
  },
  border: {
    subtle: 'rgba(0,0,0,0.06)',
    medium: 'rgba(0,0,0,0.09)',
    strong: 'rgba(0,0,0,0.16)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.05)',
    md: '0 4px 20px rgba(0,0,0,0.07)',
    lg: '0 8px 32px rgba(0,0,0,0.12)',
  },
  radius: { xs: 4, sm: 7, md: 12, lg: 16, xl: 20, full: 9999 },
  status: {
    success: '#15803D', successBg: '#DCFCE7',
    warning: '#92400E', warningBg: '#FEF3C7',
    error: '#B91C1C',   errorBg: '#FEE2E2',
    info: '#1D4ED8',    infoBg: '#DBEAFE',
  },
  user: { bubble: '#EDE5D8' },
  font: {
    sans: '"Plus Jakarta Sans", "Inter", ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
};

export type ThemeName = 'midnight' | 'light' | 'obsidian' | 'vapor' | 'aurora' | 'sand';

export const THEMES: Record<ThemeName, { label: string; tokens: ClaudeTokens; dark: boolean; preview: { bg: string; accent: string; surface: string } }> = {
  midnight: {
    label: 'Midnight',
    tokens: darkTokens,
    dark: true,
    preview: { bg: '#1a1918', accent: '#c4633a', surface: '#262624' },
  },
  obsidian: {
    label: 'Obsidian',
    tokens: obsidianTokens,
    dark: true,
    preview: { bg: '#0c0c0c', accent: '#7DAAFF', surface: '#141414' },
  },
  vapor: {
    label: 'Vapor',
    tokens: vaporTokens,
    dark: true,
    preview: { bg: '#13121f', accent: '#A78BFA', surface: '#1b1a2e' },
  },
  aurora: {
    label: 'Aurora',
    tokens: auroraTokens,
    dark: true,
    preview: { bg: '#0e1812', accent: '#4ADE80', surface: '#15221a' },
  },
  light: {
    label: 'Light',
    tokens: lightTokens,
    dark: false,
    preview: { bg: '#F5F5F0', accent: '#ae5630', surface: '#FFFFFF' },
  },
  sand: {
    label: 'Sand',
    tokens: sandTokens,
    dark: false,
    preview: { bg: '#FAF6EF', accent: '#D97706', surface: '#FFFFFF' },
  },
};

/** @deprecated Use useClaudeTokens() hook instead */
export const claude = lightTokens;
