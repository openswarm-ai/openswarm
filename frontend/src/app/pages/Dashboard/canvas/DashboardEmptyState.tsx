import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

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
    <style>{`@keyframes empty-state-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
      No agents running
    </Typography>
    <Typography
      sx={{
        fontSize: '0.9rem',
        background: `linear-gradient(90deg, ${c.text.ghost} 0%, ${c.text.ghost} 40%, ${c.text.primary} 50%, ${c.text.ghost} 60%, ${c.text.ghost} 100%)`,
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        color: 'transparent',
        animation: 'empty-state-shimmer 6s linear infinite',
      }}
    >
      Click the &quot;+&quot; button below to launch your first agent
    </Typography>
  </Box>
);

export default DashboardEmptyState;
