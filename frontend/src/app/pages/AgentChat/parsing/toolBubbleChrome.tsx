import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

let toolCallKeyframesInjected = false;
export function ensureToolCallKeyframes() {
  if (toolCallKeyframesInjected) return;
  toolCallKeyframesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-tool-call-keyframes', '');
  style.textContent = `
@keyframes tool-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes border-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--glow-rgb), 0); }
  50% { box-shadow: 0 0 10px 2px rgba(var(--glow-rgb), 0.12); }
}
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`;
  document.head.appendChild(style);
}

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
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: c.accent.primary,
          animation: 'tool-pulse 1.5s ease-in-out infinite',
        }}
      />
      <Typography
        sx={{
          fontSize: '0.7rem',
          fontFamily: c.font.mono,
          color: c.text.tertiary,
          minWidth: 28,
          textAlign: 'right',
        }}
      >
        {display}
      </Typography>
    </Box>
  );
};

export function formatElapsed(ms: number): string {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
