import React, { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export type TerminalSource = 'frontend' | 'backend' | 'runtime';

export interface TerminalLine {
  // Monotonic id so React keys stay stable when the same text logs twice (heartbeat tickers etc.).
  id: number;
  source: TerminalSource;
  // frontend: console method; backend: "stdout"/"stderr"; runtime: "info".
  level: string;
  text: string;
}

interface Props {
  lines: TerminalLine[];
}

const PREFIX_COLORS: Record<TerminalSource, string> = {
  frontend: '#60a5fa', // blue: user app
  backend: '#34d399',  // green: backend.py stdout
  runtime: '#a78bfa',  // purple: runtime manager
};

const STDERR_COLOR = '#f87171'; // red: stderr, console.error, runtime errors

function colorForLine(line: TerminalLine): string {
  if (line.source === 'backend' && line.level === 'stderr') return STDERR_COLOR;
  if (line.source === 'frontend' && line.level === 'error') return STDERR_COLOR;
  if (line.source === 'frontend' && line.level === 'warn') return '#fbbf24';
  return PREFIX_COLORS[line.source];
}

function prefixForLine(line: TerminalLine): string {
  if (line.source === 'frontend') return '[FRONTEND]';
  if (line.source === 'backend') return '[BACKEND]';
  return '[RUNTIME]';
}

const TerminalPanel: React.FC<Props> = ({ lines }) => {
  const c = useClaudeTokens();
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Stick to bottom on new lines unless the user scrolled up; 32px tolerates sub-pixel rounding.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    stickToBottomRef.current = atBottom;
  };

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        bgcolor: '#0d1117',
      }}
    >
      <Box
        ref={containerRef}
        onScroll={onScroll}
        sx={{
          flex: 1,
          overflow: 'auto',
          px: 1.5,
          py: 1,
          fontFamily: c.font.mono,
          fontSize: '0.74rem',
          lineHeight: 1.55,
          '&::-webkit-scrollbar': { width: 6, height: 6 },
          '&::-webkit-scrollbar-thumb': { background: '#21262d', borderRadius: 3 },
        }}
      >
        {lines.length === 0 ? (
          <Typography sx={{ color: '#8b949e', fontFamily: c.font.mono, fontSize: '0.78rem', fontStyle: 'italic' }}>
            Waiting for output... backend stdout/stderr and the running app's console.log will show here.
          </Typography>
        ) : (
          lines.map((line) => (
            <Box key={line.id} sx={{ display: 'flex', gap: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Box component="span" sx={{ color: colorForLine(line), fontWeight: 700, flexShrink: 0 }}>
                {prefixForLine(line)}
              </Box>
              <Box component="span" sx={{ color: '#c9d1d9' }}>
                {line.text}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
};

export default TerminalPanel;
