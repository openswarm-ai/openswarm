import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import UnfoldLessOutlinedIcon from '@mui/icons-material/UnfoldLessOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

/** Chip marking where auto-compaction collapsed older turns, so the transcript doesn't just appear to skip. */
const CompactionMarker: React.FC<{ collapsedCount: number }> = ({ collapsedCount }) => {
  const c = useClaudeTokens();
  const label = collapsedCount > 0
    ? `${collapsedCount} earlier turn${collapsedCount === 1 ? '' : 's'} summarized`
    : 'Older turns summarized';
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', my: 1.25 }}>
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.625,
          px: 1.25,
          py: 0.4,
          borderRadius: 9999,
          bgcolor: c.bg.secondary,
          border: `1px solid ${c.border.subtle}`,
          color: c.text.muted,
          cursor: 'default',
          userSelect: 'none',
        }}
      >
        <UnfoldLessOutlinedIcon sx={{ fontSize: 13, opacity: 0.7 }} />
        <Typography sx={{ fontSize: '0.7rem', lineHeight: 1, fontWeight: 500 }}>
          {label}
        </Typography>
      </Box>
    </Box>
  );
};

export default CompactionMarker;
