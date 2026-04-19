import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import SearchIcon from '@mui/icons-material/Search';
import { motion } from 'framer-motion';
import type { ClaudeTokens } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export const IdlePill: React.FC<{ c: ClaudeTokens }> = ({ c }) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.92 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={{ duration: 0.2 }}
  >
    <Tooltip title="Coming soon" arrow placement="bottom">
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.25,
          height: 24,
          userSelect: 'none',
          cursor: 'default',
        }}
      >
        <SearchIcon sx={{ fontSize: 13, color: c.text.ghost, flexShrink: 0 }} />
        <Typography
          sx={{
            color: c.text.ghost,
            fontSize: '0.66rem',
            fontWeight: 400,
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          Search...
        </Typography>
      </Box>
    </Tooltip>
  </motion.div>
);
