import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { PillState } from './installs';
import { ringFor } from './installRing';

interface Props {
  state: PillState;
  // 0..1 while a download runs; null when the size is unknown.
  progress?: number | null;
  disabled?: boolean;
  onGet: () => void;
  onOpen: () => void;
  size?: 'sm' | 'md';
}

// The one action a package has, the way the App Store draws it: Install, a spinner while it lands, then Open. It swallows the click so a card underneath never opens its sheet.
export default function InstallPill({ state, progress, disabled, onGet, onOpen, size = 'md' }: Props) {
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
  if (state === 'installing') {
    // The App Store's ring: the button gives way to a circle that fills with the bytes, in the same box so nothing shifts.
    const ring = ringFor(progress);
    const px = sm ? 18 : 22;
    return (
      <Box
        onClick={stop}
        role="progressbar"
        aria-label="Installing"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ring.variant === 'determinate' ? ring.value : undefined}
        data-install-ring={ring.variant}
        sx={{ minWidth: base.minWidth, height: sm ? 26 : 32, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative' }}
      >
        <CircularProgress variant="determinate" value={100} size={px} thickness={4} sx={{ color: c.border.subtle, position: 'absolute' }} />
        <CircularProgress
          variant={ring.variant}
          value={ring.value}
          size={px}
          thickness={4}
          sx={{ color: c.accent.primary, '& .MuiCircularProgress-circle': { strokeLinecap: 'round', transition: 'stroke-dashoffset 150ms linear' } }}
        />
      </Box>
    );
  }
  return (
    <Button
      onClick={(e) => { stop(e); if (state === 'get') onGet(); }}
      disabled={disabled}
      variant="contained"
      disableElevation
      sx={{ ...base, bgcolor: c.accent.primary, color: c.text.inverse, '&:hover': { bgcolor: c.accent.hover }, '&.Mui-disabled': { bgcolor: c.accent.primary, color: c.text.inverse, opacity: 0.5 } }}
    >
      Install
    </Button>
  );
}
