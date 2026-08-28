import { createTheme } from '@mui/material';
import type { ClaudeTokens } from './claudeTokens';
import { fontSize } from './claudeTokens';
import { alertStyleOverrides } from './alertOverrides';
import { inputStyleOverrides } from './inputOverrides';

// Extracted from Main.tsx so DarkTokensScope can build one too. A subtree that forces dark tokens
// must force the MUI palette with them: it used to swap only OUR ThemeContext, leaving the MUI
// provider at the app's light mode, so an agent card painted dark while MUI handed every input
// light-mode text.primary. Measured: text rgb(26,26,24) on card rgb(31,30,27), contrast 4/255 --
// the invisible "Other..." box (ENG-419).

export function buildMuiTheme(c: ClaudeTokens, mode: 'light' | 'dark') {
  return createTheme({
    palette: {
      mode,
      background: {
        default: c.bg.page,
        paper: c.bg.surface,
      },
      primary: {
        main: c.accent.primary,
        dark: c.accent.pressed,
        light: c.accent.hover,
      },
      text: {
        primary: c.text.primary,
        secondary: c.text.muted,
        disabled: c.text.tertiary,
      },
      divider: c.border.medium,
      error: { main: c.status.error },
      warning: { main: c.status.warning },
      success: { main: c.status.success },
      info: { main: c.status.info },
    },
    typography: {
      fontFamily: c.font.sans,
      h1: { fontWeight: 600 },
      h2: { fontWeight: 600 },
      h3: { fontWeight: 600 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
      button: { textTransform: 'none' as const, fontWeight: 500 },
    },
    shape: {
      borderRadius: c.radius.xl,
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: c.bg.page,
            color: c.text.primary,
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.border.strong} transparent`,
          },
          '*': {
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.border.strong} transparent`,
          },
          '*::-webkit-scrollbar': {
            width: '6px',
            height: '6px',
          },
          '*::-webkit-scrollbar-track': {
            background: 'transparent',
          },
          '*::-webkit-scrollbar-thumb': {
            background: c.border.strong,
            borderRadius: '3px',
          },
          '*::-webkit-scrollbar-thumb:hover': {
            background: c.text.ghost,
          },
          '*::-webkit-scrollbar-corner': {
            background: 'transparent',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: c.radius.lg,
            transition: c.transition,
            textTransform: 'none' as const,
            '&:active': { transform: 'scale(0.98)' },
          },
          contained: {
            boxShadow: 'none',
            '&:hover': { boxShadow: 'none' },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            boxShadow: c.shadow.md,
            border: `1px solid ${c.border.subtle}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            fontWeight: 500,
            borderRadius: c.radius.md,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            boxShadow: c.shadow.lg,
            border: `1px solid ${c.border.subtle}`,
          },
        },
      },
      MuiAlert: { styleOverrides: alertStyleOverrides(c) },
      MuiOutlinedInput: { styleOverrides: inputStyleOverrides(c) },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: c.bg.inverse,
            color: c.text.inverse,
            fontSize: '0.75rem',
          },
        },
      },
    },
  });
}
