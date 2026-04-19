import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion } from 'framer-motion';
import { ActivityIndicator } from './ActivityIndicator';
import { SPRING_BOUNCE } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';
import type { ClaudeTokens } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export const CompactPill: React.FC<{
  c: ClaudeTokens;
  text: string;
  activeCount: number;
  hasApprovals: boolean;
}> = ({ c, text, activeCount, hasApprovals }) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.92 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={SPRING_BOUNCE}
  >
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.5,
        height: 24,
        userSelect: 'none',
      }}
    >
      <ActivityIndicator c={c} />
      <Typography
        sx={{
          fontSize: '0.68rem',
          fontWeight: 500,
          color: c.text.tertiary,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </Typography>
      {hasApprovals && (
        <Box
          sx={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            bgcolor: c.accent.primary,
            flexShrink: 0,
            opacity: 0.8,
          }}
        />
      )}
    </Box>
  </motion.div>
);
