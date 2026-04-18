import React, { useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { OverlayEntry } from './OverlayEntry';

interface Props {
  entries: OverlayEntry[];
  expanded: boolean;
  isRunning: boolean;
  accentColor: string;
  messageCount: number;
  streamingContent: string | undefined;
}

const OverlayActionLog: React.FC<Props> = ({
  entries,
  expanded,
  isRunning,
  accentColor,
  messageCount,
  streamingContent,
}) => {
  const c = useClaudeTokens();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messageCount, streamingContent]);

  return (
    <Box
      ref={scrollRef}
      sx={{
        flex: 1,
        overflowY: 'auto',
        px: 1.25,
        py: 0.75,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.12) transparent',
        '&::-webkit-scrollbar': { width: 4 },
        '&::-webkit-scrollbar-thumb': {
          background: 'rgba(255,255,255,0.12)',
          borderRadius: 2,
        },
      }}
    >
      {entries.length === 0 && isRunning && (
        <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>
          Starting...
        </Typography>
      )}

      {entries.map((entry, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start', minWidth: 0 }}>
          {entry.type === 'thought' ? (
            <>
              <Box
                sx={{
                  width: 4,
                  height: 4,
                  borderRadius: '50%',
                  bgcolor: 'rgba(255,255,255,0.25)',
                  flexShrink: 0,
                  mt: '5px',
                }}
              />
              <Typography
                sx={{
                  fontSize: '0.68rem',
                  color: 'rgba(255,255,255,0.6)',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: expanded ? 6 : 2,
                  WebkitBoxOrient: 'vertical',
                  wordBreak: 'break-word',
                }}
              >
                {entry.text}
              </Typography>
            </>
          ) : (
            <>
              <Box
                sx={{
                  width: 4,
                  height: 4,
                  borderRadius: '1px',
                  bgcolor: accentColor,
                  flexShrink: 0,
                  mt: '5px',
                  transform: 'rotate(45deg)',
                }}
              />
              <Typography
                sx={{
                  fontSize: '0.68rem',
                  fontFamily: c.font.mono,
                  color: accentColor,
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.text}
              </Typography>
            </>
          )}
        </Box>
      ))}
    </Box>
  );
};

export default React.memo(OverlayActionLog);
