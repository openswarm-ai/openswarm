import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

export const STATUS_DOT: Record<string, string> = {
  running: '#22c55e',
  waiting_approval: '#f59e0b',
  completed: '#94a3b8',
  error: '#ef4444',
  stopped: '#94a3b8',
  draft: '#6366f1',
};

export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

export const CategoryGroup: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  c: ReturnType<typeof useClaudeTokens>;
  children: React.ReactNode;
}> = ({ icon, label, count, c, children }) => (
  <Box sx={{ '&:not(:first-of-type)': { borderTop: `1px solid ${c.border.light}`, mt: 0.5, pt: 0.5 } }}>
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.5,
        py: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', color: c.text.tertiary, '& > svg': { fontSize: 15 } }}>{icon}</Box>
      <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost }}>
        {count}
      </Typography>
    </Box>
    {children}
  </Box>
);

export const ItemRow: React.FC<{
  onClick: () => void;
  c: ReturnType<typeof useClaudeTokens>;
  children: React.ReactNode;
}> = ({ onClick, c, children }) => (
  <Box
    onClick={onClick}
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 0.75,
      px: 1.5,
      pl: 3.25,
      py: 0.4,
      cursor: 'pointer',
      borderRadius: 0.5,
      mx: 0.5,
      '&:hover': { bgcolor: c.bg.secondary },
      transition: 'background-color 0.1s',
    }}
  >
    {children}
  </Box>
);
