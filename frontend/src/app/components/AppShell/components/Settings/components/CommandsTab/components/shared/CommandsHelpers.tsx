import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';

export const KeyBadge: React.FC<{ keys: string; c: any }> = ({ keys, c }) => (
  <Box
    sx={{
      bgcolor: c.bg.secondary,
      border: `1px solid ${c.border.medium}`,
      borderRadius: 1.5,
      px: 1.25,
      py: 0.4,
      display: 'inline-flex',
      alignItems: 'center',
    }}
  >
    <Typography
      sx={{
        color: c.accent.primary,
        fontSize: '0.75rem',
        fontFamily: c.font.mono,
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {keys}
    </Typography>
  </Box>
);

export const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count?: number;
  c: any;
}> = ({ icon, title, subtitle, count, c }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
    <Box sx={{ color: c.accent.primary, display: 'flex', alignItems: 'center' }}>{icon}</Box>
    <Box sx={{ flex: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
          {title}
        </Typography>
        {count !== undefined && (
          <Chip
            label={count}
            size="small"
            sx={{
              height: 20,
              fontSize: '0.7rem',
              fontWeight: 600,
              bgcolor: `${c.accent.primary}15`,
              color: c.accent.primary,
            }}
          />
        )}
      </Box>
      <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem' }}>{subtitle}</Typography>
    </Box>
  </Box>
);
