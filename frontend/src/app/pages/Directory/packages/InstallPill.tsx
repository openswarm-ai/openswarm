import React from 'react';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { PillState } from './installs';

interface Props {
  state: PillState;
  disabled?: boolean;
  onGet: () => void;
  onOpen: () => void;
  size?: 'sm' | 'md';
}

// The one action a package has, the way the App Store draws it: Get, a spinner while it lands, then Open. It swallows the click so a card underneath never opens its sheet.
export default function InstallPill({ state, disabled, onGet, onOpen, size = 'md' }: Props) {
  const c = useClaudeTokens();
  const sm = size === 'sm';
  const base = {
    borderRadius: `${c.radius.full}px`,
    textTransform: 'none' as const,
    fontWeight: 650,
    fontSize: sm ? '0.75rem' : '0.8125rem',
    px: sm ? 1.75 : 2.25,
    py: sm ? 0.35 : 0.6,
    minWidth: sm ? 58 : 72,
    lineHeight: 1.5,
    flexShrink: 0,
  };
  const stop = (e: React.MouseEvent) => { e.stopPropagation(); };
  if (state === 'installed') {
    return (
      <Button onClick={stop} disabled variant="outlined" startIcon={<CheckRoundedIcon sx={{ fontSize: 15 }} />} sx={{ ...base, '&.Mui-disabled': { color: c.text.muted, borderColor: c.border.subtle } }}>
        Installed
      </Button>
    );
  }
  if (state === 'open') {
    return (
      <Button onClick={(e) => { stop(e); onOpen(); }} variant="outlined" sx={{ ...base, color: c.accent.primary, borderColor: c.accent.primary, bgcolor: c.bg.surface, '&:hover': { bgcolor: c.bg.elevated, borderColor: c.accent.hover } }}>
        Open
      </Button>
    );
  }
  return (
    <Button
      onClick={(e) => { stop(e); if (state === 'get') onGet(); }}
      disabled={disabled || state === 'installing'}
      variant="contained"
      disableElevation
      sx={{ ...base, bgcolor: c.accent.primary, color: c.text.inverse, '&:hover': { bgcolor: c.accent.hover }, '&.Mui-disabled': { bgcolor: c.accent.primary, color: c.text.inverse, opacity: state === 'installing' ? 1 : 0.5 } }}
    >
      {state === 'installing' ? <CircularProgress size={14} thickness={5} sx={{ color: 'inherit' }} /> : 'Get'}
    </Button>
  );
}
