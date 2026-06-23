import type { CSSProperties } from 'react';
import { useThemeMode, useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

// The Workflows app renders in its own warm-paper visual language (from the
// Claude design), deliberately separate from the MUI theme so the window reads
// as a focused app. Two palettes (light/dark) keyed to the app theme; grab one
// per component with useWC(). inkRGB is the ink color as a bare "r,g,b" so the
// many rgba(ink, opacity) borders/hovers can flip with the theme too.
export interface WCPalette {
  accent: string;
  paper: string;
  page: string;
  panel: string;
  rail: string;
  inset: string;
  raised: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  muted: string;
  muted2: string;
  faint: string;
  inkRGB: string;
  line: string;
  line2: string;
  hover: string;
  selBg: string;
  success: string;
  successBg: string;
  danger: string;
  dangerBg: string;
  warn: string;
  warnBg: string;
  trackOff: string;
  // Structural primitives shared with the rest of OpenSwarm (sourced from
  // claudeTokens in useWC), so the window stops looking built-separate.
  shadow: ClaudeTokens['shadow'];
  radius: ClaudeTokens['radius'];
  border: ClaudeTokens['border'];
}

// The identity half of the palette: accent, text, status, hairlines. The neutral
// surfaces + structural primitives are blended in from claudeTokens by useWC(),
// so the window is the same material as every other card.
type WCColors = Omit<WCPalette, 'shadow' | 'radius' | 'border' | 'paper' | 'page' | 'panel' | 'rail' | 'inset' | 'raised'>;

export const WC_LIGHT: WCColors = {
  accent: '#C25A36',
  ink: '#211E1B',
  ink2: '#2B2722',
  ink3: '#4B463E',
  ink4: '#6B655C',
  muted: '#73726C',
  muted2: '#8C857A',
  faint: '#A39C92',
  inkRGB: '33,30,27',
  line: 'rgba(33,30,27,0.07)',
  line2: 'rgba(33,30,27,0.12)',
  hover: 'rgba(33,30,27,0.045)',
  selBg: 'rgba(33,30,27,0.06)',
  success: '#2E7D5B',
  successBg: 'rgba(46,125,91,0.12)',
  danger: '#C2483A',
  dangerBg: 'rgba(194,72,58,0.10)',
  warn: '#B98A2E',
  warnBg: 'rgba(185,138,46,0.14)',
  trackOff: '#D5D1C8',
};

export const WC_DARK: WCColors = {
  accent: '#C25A36',
  ink: '#F2EFE9',
  ink2: '#E2DDD4',
  ink3: '#B3ABA0',
  ink4: '#9A9389',
  muted: '#938C82',
  muted2: '#736D64',
  faint: '#6E6860',
  inkRGB: '240,236,228',
  line: 'rgba(240,236,228,0.07)',
  line2: 'rgba(240,236,228,0.12)',
  hover: 'rgba(240,236,228,0.045)',
  selBg: 'rgba(240,236,228,0.06)',
  success: '#2E7D5B',
  successBg: 'rgba(46,125,91,0.22)',
  danger: '#C2483A',
  dangerBg: 'rgba(194,72,58,0.18)',
  warn: '#B98A2E',
  warnBg: 'rgba(185,138,46,0.18)',
  trackOff: 'rgba(240,236,228,0.18)',
};

export function useWC(): WCPalette {
  const { mode } = useThemeMode();
  const c = useClaudeTokens();
  const base = mode === 'dark' ? WC_DARK : WC_LIGHT;
  return {
    ...base,
    // Three-tone depth from the app tokens (matches the Claude design): the
    // content area sits on `page`, cards/title bar pop on `surface` above it,
    // and the sidebar/right rail recede on `secondary`. surface > page in BOTH
    // themes, so cards always pop (no light/dark inversion).
    // Light's palette inverts (elevated is lighter than surface in light, darker
    // in dark), so the mid content tone must flip per mode: in light it steps UP
    // to bg.elevated so the window stands apart from the bg.page canvas behind it
    // and cards still pop on bg.surface above; in dark bg.page is already darker
    // than the cards, so it stays. Rows mirror it (surface in light, elevated in
    // dark) so they always sit above the content.
    paper: c.bg.surface,                                       // cards, title bar, popovers
    page: mode === 'dark' ? c.bg.secondary : c.bg.elevated,   // content area: one step above the canvas in both modes
    panel: c.bg.surface,                                       // title bar
    rail: mode === 'dark' ? c.bg.page : c.bg.secondary,        // sidebar / right rail: the recessed darkest column
    inset: c.bg.page,
    raised: mode === 'dark' ? c.bg.elevated : c.bg.surface,    // extra-raised rows / dropdowns
    shadow: c.shadow,
    radius: c.radius,
    border: c.border,
  };
}

export const FONT_SERIF = "'Newsreader', Georgia, serif";
export const FONT_SANS = "'Hanken Grotesk', system-ui, sans-serif";
export const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";

// Stable per-workflow color: the backend has no color field, so derive a
// vivid-but-deterministic swatch from the id. Same id always lands the same
// hue, so dots/bars stay consistent across panes without persistence.
export const WORKFLOW_PALETTE = [
  '#C25A36', '#3F8E83', '#5B6CB8', '#9A5B86',
  '#B5852E', '#C2483A', '#4B7A4B', '#4B463E',
];

export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WORKFLOW_PALETTE[h % WORKFLOW_PALETTE.length];
}

// Prefer the user's chosen swatch; fall back to the stable id-hash hue when
// they haven't picked one. Single source of truth for every dot/bar.
export function colorForWorkflow(wf: { id: string; color?: string | null }): string {
  return wf.color || colorForId(wf.id);
}

export type RunStatus = 'success' | 'failure' | 'ran_late' | 'running' | 'skipped' | 'paused';

export function statusChip(status: RunStatus, wc: WCPalette): CSSProperties {
  const map: Record<string, [string, string]> = {
    success: [wc.success, wc.successBg],
    ran_late: [wc.warn, wc.warnBg],
    failure: [wc.danger, wc.dangerBg],
    skipped: [wc.muted, `rgba(${wc.inkRGB},0.07)`],
    running: [wc.accent, `rgba(${wc.inkRGB},0.06)`],
    paused: [wc.muted, `rgba(${wc.inkRGB},0.07)`],
  };
  const [color, background] = map[status] || map.paused;
  return {
    fontSize: 11, fontWeight: 600, color, background,
    padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', flex: 'none',
  };
}

export function statusDot(status: RunStatus, wc: WCPalette): CSSProperties {
  const map: Record<string, string> = {
    success: wc.success, ran_late: wc.warn, failure: wc.danger,
    running: wc.accent, skipped: wc.faint, paused: wc.faint,
  };
  return { width: 8, height: 8, borderRadius: '50%', background: map[status] || wc.faint, flex: 'none' };
}

export function track(on: boolean, wc: WCPalette): CSSProperties {
  return {
    width: 34, height: 20, borderRadius: 999, background: on ? wc.accent : wc.trackOff,
    position: 'relative', cursor: 'pointer', transition: 'background .15s', flex: 'none',
  };
}

export function knob(on: boolean): CSSProperties {
  return {
    position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
    background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.25)',
  };
}

export function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'success': return 'Success';
    case 'failure': return 'Failed';
    case 'ran_late': return 'Ran late';
    case 'running': return 'Running';
    case 'skipped': return 'Skipped';
    default: return 'Paused';
  }
}
