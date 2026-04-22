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
  radius: { xs: 4, sm: 6, md: 8, lg: 10, xl: 12, full: 9999 },
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
  },
  transition: 'all 300ms cubic-bezier(0.165, 0.85, 0.45, 1)',
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
  radius: { xs: 4, sm: 6, md: 8, lg: 10, xl: 12, full: 9999 },
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
  },
  transition: 'all 300ms cubic-bezier(0.165, 0.85, 0.45, 1)',
};

/** @deprecated Use useClaudeTokens() hook instead for dark mode support */
export const claude = lightTokens;
