import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import ChatBubbleTeardrop from '../ChatBubbleTeardrop';

const DashboardEmptyState: React.FC<{ c: ClaudeTokens }> = ({ c }) => (
  <Box
    sx={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
    }}
  >
    <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
      No agents running
    </Typography>
    <Typography
      sx={{
        fontSize: '0.9rem',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.7,
        color: c.text.primary,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      Click the
      <Box component="span" sx={{ display: 'inline-flex', color: c.text.tertiary }}>
        <ChatBubbleTeardrop sx={{ fontSize: 15 }} />
      </Box>
      below to launch your first agent
      {/* Sheen sweeps via transform only: the layer rasters once and the GPU slides it, unlike the old background-position shimmer that repainted every frame. */}
      <Box
        component="span"
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'linear-gradient(105deg, transparent 42%, rgba(255,255,255,0.14) 50%, transparent 58%)',
          transform: 'translateX(-100%)',
          animation: 'empty-state-sheen 6s linear infinite',
          willChange: 'transform',
          '@keyframes empty-state-sheen': { to: { transform: 'translateX(100%)' } },
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      />
    </Typography>
  </Box>
);

export default DashboardEmptyState;
