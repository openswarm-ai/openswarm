import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

type Mode = 'light' | 'dark';

const FONT_SERIF = '"Anthropic Sans", ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const lightTokens = {
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
    ghost: 'rgba(115,114,108,0.5)',
  },
  accent: {
    primary: '#ae5630',
    hover: '#c4633a',
    pressed: '#924828',
  },
  user: { bubble: '#DDD9CE' },
  border: {
    subtle: 'rgba(0,0,0,0.07)',
    medium: 'rgba(0,0,0,0.10)',
    strong: 'rgba(0,0,0,0.18)',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.04)',
    md: '0 0.25rem 1.25rem rgba(0,0,0,0.035)',
    lg: '0 0.5rem 2rem rgba(0,0,0,0.08)',
  },
  status: {
    success: '#2e7d32',
    successBg: 'rgba(46,125,50,0.08)',
    error: '#c62828',
    errorBg: 'rgba(198,40,40,0.08)',
  },
};

const darkTokens = {
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
    ghost: 'rgba(156,154,146,0.5)',
  },
  accent: {
    primary: '#c4633a',
    hover: '#d47548',
    pressed: '#ae5630',
  },
  user: { bubble: '#393937' },
  border: {
    subtle: 'rgba(255,255,255,0.07)',
    medium: 'rgba(255,255,255,0.10)',
    strong: 'rgba(255,255,255,0.18)',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.12)',
    md: '0 0.25rem 1.25rem rgba(0,0,0,0.15)',
    lg: '0 0.5rem 2rem rgba(0,0,0,0.25)',
  },
  status: {
    success: '#66bb6a',
    successBg: 'rgba(102,187,106,0.12)',
    error: '#ef5350',
    errorBg: 'rgba(239,83,80,0.12)',
  },
};

const sharedTokens = {
  radius: {
    xs: 4,
    sm: 6,
    md: 8,
    lg: 10,
    xl: 12,
    full: 9999,
  },
  font: {
    serif: FONT_SERIF,
    mono: FONT_MONO,
  },
  transition: 'all 300ms cubic-bezier(0.165, 0.85, 0.45, 1)',
};

export type ClaudeTokens = typeof lightTokens & typeof sharedTokens;

function buildTokens(mode: Mode): ClaudeTokens {
  const modeTokens = mode === 'light' ? lightTokens : darkTokens;
  return { ...modeTokens, ...sharedTokens };
}

interface ThemeModeContextValue {
  mode: Mode;
  toggleMode: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'light',
  toggleMode: () => {},
});

const TokensContext = createContext<ClaudeTokens>(buildTokens('light'));

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

export function useClaudeTokens(): ClaudeTokens {
  return useContext(TokensContext);
}

interface ClaudeThemeProviderProps {
  children: React.ReactNode;
}

const ClaudeThemeProvider: React.FC<ClaudeThemeProviderProps> = ({ children }) => {
  const [mode, setMode] = useState<Mode>('light');

  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      console.log(`[Theme] Toggled ${prev} → ${next}`);
      return next;
    });
  }, []);

  const tokens = useMemo(() => buildTokens(mode), [mode]);

  const muiTheme = useMemo(
    () =>
      createTheme({
        palette: { mode },
        typography: {
          fontFamily: FONT_SERIF,
          button: { textTransform: 'none' as const },
        },
        components: {
          MuiCssBaseline: {
            styleOverrides: {
              body: {
                backgroundColor: tokens.bg.page,
                color: tokens.text.primary,
                transition: 'background-color 300ms ease, color 300ms ease',
              },
            },
          },
        },
      }),
    [mode, tokens],
  );

  const modeValue = useMemo(() => ({ mode, toggleMode }), [mode, toggleMode]);

  return (
    <ThemeModeContext.Provider value={modeValue}>
      <TokensContext.Provider value={tokens}>
        <ThemeProvider theme={muiTheme}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </TokensContext.Provider>
    </ThemeModeContext.Provider>
  );
};

export default ClaudeThemeProvider;
