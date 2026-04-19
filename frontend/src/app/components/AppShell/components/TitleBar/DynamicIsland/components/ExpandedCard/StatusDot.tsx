import React from 'react';
import Box from '@mui/material/Box';
import { STATUS_CONFIG } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';
import type { ClaudeTokens } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export const StatusDot: React.FC<{ status: string; c: ClaudeTokens }> = ({ status, c }) => {
  const cfg = STATUS_CONFIG[status];
  const color = cfg?.tokenKey ? (c.status as any)[cfg.tokenKey] : c.text.ghost;
  const isActive = status === 'running';
  return (
    <Box
      sx={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        bgcolor: color,
        flexShrink: 0,
        opacity: 0.8,
        ...(isActive && {
          animation: 'islandPulse 2s ease-in-out infinite',
          '@keyframes islandPulse': {
            '0%, 100%': { opacity: 0.8, transform: 'scale(1)' },
            '50%': { opacity: 0.4, transform: 'scale(1.3)' },
          },
        }),
      }}
    />
  );
};