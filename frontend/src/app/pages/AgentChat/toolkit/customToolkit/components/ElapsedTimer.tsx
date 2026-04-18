import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export const ElapsedTimer: React.FC<{ startTime: string }> = ({ startTime }) => {
  const c = useClaudeTokens();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startTime).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const display = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box
        sx={{
          width: 6, height: 6, borderRadius: '50%',
          bgcolor: c.accent.primary,
          animation: 'tool-pulse 1.5s ease-in-out infinite',
        }}
      />
      <Typography
        sx={{
          fontSize: '0.7rem', fontFamily: c.font.mono,
          color: c.text.tertiary, minWidth: 28, textAlign: 'right',
        }}
      >
        {display}
      </Typography>
    </Box>
  );
};
