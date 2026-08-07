import { ClaudeTokens } from '@/shared/styles/claudeTokens';

// Theme-dependent style objects shared across Settings tabs; built from the resolved Claude tokens.
export function makeSettingsStyles(c: ClaudeTokens) {
  const fieldSx = {
    '& .MuiOutlinedInput-root': {
      fontSize: '0.875rem',
    },
  };

  const sectionSx = {
    fontSize: '0.6875rem',
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase' as const,
    color: c.text.muted,
    mb: 1,
    mt: 2.5,
    px: 0.5,
  };

  // claude.ai settings grammar: plain rows with a single hairline between them, no per-row cards.
  const rowSx = {
    px: 0.5,
    py: 2,
    borderBottom: `1px solid ${c.border.subtle}`,
    '&:last-of-type': { borderBottom: 'none' },
  };

  const rowLastSx = {
    ...rowSx,
    borderBottom: 'none',
  };

  const inlineRowSx = {
    ...rowSx,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const inlineRowLastSx = {
    ...rowLastSx,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const labelSx = {
    color: c.text.primary,
    fontWeight: 500,
    fontSize: '0.875rem',
    lineHeight: 1.4,
  };

  const descSx = {
    color: c.text.tertiary,
    fontSize: '0.8125rem',
    lineHeight: 1.45,
  };

  const toggleGroupSx = {
    '& .MuiToggleButton-root': {
      color: c.text.muted,
      borderColor: c.border.medium,
      textTransform: 'none' as const,
      whiteSpace: 'nowrap' as const,
      px: 1.75,
      py: 0.5,
      gap: 0.5,
      fontSize: '0.8125rem',
      '&.Mui-selected': {
        bgcolor: `${c.accent.primary}15`,
        color: c.accent.primary,
        borderColor: c.accent.primary,
        '&:hover': { bgcolor: `${c.accent.primary}20` },
      },
    },
  };

  const switchSx = {
    '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
  };

  return { fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, inlineRowLastSx, labelSx, descSx, toggleGroupSx, switchSx };
}

export type SettingsStyles = ReturnType<typeof makeSettingsStyles>;
