import React from 'react';
import Box from '@mui/material/Box';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SxProps } from '@mui/material/styles';

/** The breadcrumb dot for a downloaded update: gear tile -> Advanced rail row -> the relaunch row. Renders nothing until the update is actually sitting on disk, so it can never nag about something a click cannot deliver. */
const UpdateReadyDot: React.FC<{ size?: number; sx?: SxProps }> = ({ size = 8, sx }) => {
  const c = useClaudeTokens();
  const ready = useAppSelector((s) => s.update.status === 'downloaded' && !s.update.installing);
  if (!ready) return null;
  return (
    <Box
      aria-label="Update ready"
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: c.accent.primary,
        boxShadow: `0 0 0 2px ${c.bg.surface}, 0 0 6px ${c.accent.primary}80`,
        flexShrink: 0,
        pointerEvents: 'none',
        ...sx,
      }}
    />
  );
};

export default UpdateReadyDot;
