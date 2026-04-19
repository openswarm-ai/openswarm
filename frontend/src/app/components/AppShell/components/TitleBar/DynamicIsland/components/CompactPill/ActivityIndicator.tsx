import React from 'react';
import Box from '@mui/material/Box';
import type { ClaudeTokens } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export const ActivityIndicator: React.FC<{ c: ClaudeTokens }> = ({ c }) => (
  <Box
    sx={{
      width: 6,
      height: 6,
      borderRadius: '50%',
      bgcolor: c.text.tertiary,
      flexShrink: 0,
      animation: 'subtlePulse 2.2s ease-in-out infinite',
      '@keyframes subtlePulse': {
        '0%, 100%': { opacity: 0.6, transform: 'scale(1)' },
        '50%': { opacity: 1, transform: 'scale(1.15)' },
      },
    }}
  />
);
