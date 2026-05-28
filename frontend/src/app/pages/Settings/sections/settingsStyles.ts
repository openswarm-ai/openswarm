// Theme-dependent style objects shared across Settings tabs; built from the resolved Claude tokens.
export function makeSettingsStyles(c: any) {
  const fieldSx = {
    '& .MuiOutlinedInput-root': {
      fontSize: '0.85rem',
    },
  };

  const sectionSx = {
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: c.text.tertiary,
    mb: 0.5,
    mt: 0.5,
  };

  const rowSx = {
    py: 2,
    borderBottom: `1px solid ${c.border.subtle}`,
  };

  const rowLastSx = {
    py: 2,
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
    fontSize: '0.75rem',
    lineHeight: 1.4,
  };

  return { fieldSx, sectionSx, rowSx, rowLastSx, inlineRowSx, inlineRowLastSx, labelSx, descSx };
}

export type SettingsStyles = ReturnType<typeof makeSettingsStyles>;
