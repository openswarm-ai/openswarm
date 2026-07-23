// The type scale. OpenSwarm had ~30 near-duplicate hardcoded rem sizes (0.78/0.8/0.82/0.85...), which
// reads as noise; snap to these 7 steps so type feels intentional and consistent. px comments assume a
// 16px root. Use c.font.size.* instead of a raw rem string in anything you touch.
export interface FontSizeScale {
  xs: string;      // 12px, captions, meta, micro labels
  sm: string;      // 13px, secondary / small body
  base: string;    // 14px, default body + most UI text
  md: string;      // 16px, emphasized body, inputs
  lg: string;      // 18px, subheads
  xl: string;      // 22px, section headings
  display: string; // 28px, hero / empty-state headline
}

export const fontSize: FontSizeScale = {
  xs: '0.75rem',
  sm: '0.8125rem',
  base: '0.875rem',
  md: '1rem',
  lg: '1.125rem',
  xl: '1.375rem',
  display: '1.75rem',
};

export interface ClaudeTokens {
  bg: { page: string; surface: string; elevated: string; secondary: string; inverse: string };
  text: { primary: string; secondary: string; tertiary: string; muted: string; inverse: string; ghost: string };
  accent: { primary: string; hover: string; pressed: string };
  border: { subtle: string; medium: string; strong: string; width: string };
  shadow: { sm: string; md: string; lg: string };
  radius: { xs: number; sm: number; md: number; lg: number; xl: number; full: number };
  status: { success: string; successBg: string; warning: string; warningBg: string; error: string; errorBg: string; info: string; infoBg: string };
  user: { bubble: string };
  font: { sans: string; mono: string; size: FontSizeScale };
  transition: string;
}

export const lightTokens: ClaudeTokens = {
  bg: {
    page: '#F5F5F0',
    surface: '#FFFFFF',
    elevated: '#FAF9F5',
    secondary: '#F5F4ED',
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
    medium: 'rgba(0,0,0,0.08)',
    strong: 'rgba(0,0,0,0.15)',
    width: '0.5px',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.04)',
    md: '0 0.25rem 1.25rem rgba(0,0,0,0.035)',
    lg: '0 0.5rem 2rem rgba(0,0,0,0.08)',
  },
  radius: { xs: 8, sm: 8, md: 8, lg: 8, xl: 8, full: 9999 },
  status: {
    success: '#265B19',
    successBg: '#E9F1DC',
    warning: '#805C1F',
    warningBg: '#F6EEDF',
    error: '#B53333',
    errorBg: '#FEE2E2',
    info: '#3266AD',
    infoBg: '#D6E4F6',
  },
  user: { bubble: '#DDD9CE' },
  font: {
    sans: '"Anthropic Sans", ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    size: fontSize,
  },
  transition: 'all 150ms cubic-bezier(0.165, 0.85, 0.45, 1)',
};

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
    md: '0 0.25rem 1.25rem rgba(0,0,0,0.15)',
    lg: '0 0.5rem 2rem rgba(0,0,0,0.25)',
  },
  radius: { xs: 8, sm: 8, md: 8, lg: 8, xl: 8, full: 9999 },
  status: {
    success: '#7AB948',
    successBg: '#1B4614',
    warning: '#D1A041',
    warningBg: '#483A0F',
    error: '#DD5353',
    errorBg: '#3D1515',
    info: '#80AADD',
    infoBg: '#253E5F',
  },
  user: { bubble: '#393937' },
  font: {
    sans: '"Anthropic Sans", ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    size: fontSize,
  },
  transition: 'all 150ms cubic-bezier(0.165, 0.85, 0.45, 1)',
};

/** @deprecated Use useClaudeTokens() hook instead for dark mode support */
export const claude = lightTokens;

// Onboarding's color pad hands us one hex; the full accent triad (primary/hover/pressed) is derived here so every consumer of tokens.accent re-themes from a single stored value.

export interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function withAccent(base: ClaudeTokens, accentHex: string | null, mode: 'light' | 'dark'): ClaudeTokens {
  if (!accentHex) return base;
  const hsl = hexToHsl(accentHex);
  if (!hsl) return base;
  // Clamp lightness per mode so a near-white or near-black pick still reads as a usable accent against its ground.
  const l = mode === 'dark' ? clamp(hsl.l, 0.45, 0.68) : clamp(hsl.l, 0.28, 0.55);
  const s = clamp(hsl.s, 0.25, 0.95);
  const primary = hslToHex({ h: hsl.h, s, l });
  const hover = hslToHex({ h: hsl.h, s, l: clamp(l + 0.07, 0, 0.8) });
  const pressed = hslToHex({ h: hsl.h, s, l: clamp(l - 0.07, 0.15, 1) });
  return { ...base, accent: { primary, hover, pressed } };
}
