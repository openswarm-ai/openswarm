import { useThemeMode } from '@/shared/styles/ThemeContext';

export interface CardColors {
  TC_BG: string;
  TC_BORDER: string;
  TC_HOVER: string;
  TC_HEADING: string;
  TC_BODY: string;
  TC_MUTED: string;
  TC_DIM: string;
  TC_ACCENT: string;
  TC_SUCCESS: string;
  TC_WARNING: string;
}

const darkCardColors: CardColors = {
  TC_BG: 'rgba(255,255,255,0.03)',
  TC_BORDER: 'rgba(255,255,255,0.06)',
  TC_HOVER: 'rgba(255,255,255,0.05)',
  TC_HEADING: '#C2C0B6',
  TC_BODY: '#9C9A92',
  TC_MUTED: '#85837C',
  TC_DIM: 'rgba(156,154,146,0.5)',
  TC_ACCENT: '#c4633a',
  TC_SUCCESS: '#7AB948',
  TC_WARNING: '#D1A041',
};

const lightCardColors: CardColors = {
  TC_BG: 'rgba(0,0,0,0.03)',
  TC_BORDER: 'rgba(0,0,0,0.08)',
  TC_HOVER: 'rgba(0,0,0,0.05)',
  TC_HEADING: '#3D3D3A',
  TC_BODY: '#555550',
  TC_MUTED: '#73726C',
  TC_DIM: 'rgba(115,114,108,0.5)',
  TC_ACCENT: '#ae5630',
  TC_SUCCESS: '#265B19',
  TC_WARNING: '#805C1F',
};

export function useCardColors(): CardColors {
  const { mode } = useThemeMode();
  return mode === 'dark' ? darkCardColors : lightCardColors;
}
