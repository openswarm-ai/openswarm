// Premium onboarding skin (Claude-onboarding aesthetic) that follows the user's light/dark theme.
// Same layout/typography in both modes; only the palette flips.

import { useThemeMode } from '@/shared/styles/ThemeContext';

export interface OnboardingSkin {
  bg: string;
  surface: string;
  surfaceHover: string;
  text: string;
  muted: string;
  ghost: string;
  accent: string;
  border: string;
  borderStrong: string;
  ctaBg: string;
  ctaText: string;
  serif: string;
  sans: string;
  radius: number;
}

const SERIF = '"Copernicus", "Tiempos Headline", Georgia, "Times New Roman", serif';
const SANS = '"Styrene B", "Anthropic Sans", -apple-system, "SF Pro Text", system-ui, sans-serif';

const DARK: OnboardingSkin = {
  bg: '#1C1B19',
  surface: '#252420',
  surfaceHover: '#2B2A25',
  text: '#F3F1EA',
  muted: '#8F8D86',
  ghost: '#6F6E68',
  accent: '#D97757',
  border: 'rgba(243,241,234,0.08)',
  borderStrong: 'rgba(243,241,234,0.14)',
  ctaBg: '#F3F1EA',
  ctaText: '#1A1917',
  serif: SERIF,
  sans: SANS,
  radius: 16,
};

const LIGHT: OnboardingSkin = {
  bg: '#F5F5F0',
  surface: '#FFFFFF',
  surfaceHover: '#F5F4ED',
  text: '#1A1A18',
  muted: '#73726C',
  ghost: 'rgba(115,114,108,0.65)',
  accent: '#C4633A',
  border: 'rgba(0,0,0,0.08)',
  borderStrong: 'rgba(0,0,0,0.14)',
  ctaBg: '#1A1A18',
  ctaText: '#F5F5F0',
  serif: SERIF,
  sans: SANS,
  radius: 16,
};

export function useOnboardingSkin(): OnboardingSkin {
  return useThemeMode().mode === 'dark' ? DARK : LIGHT;
}

// framer-motion cubic-bezier for entrances.
export const ONBOARDING_EASE = [0.16, 1, 0.3, 1] as const;
