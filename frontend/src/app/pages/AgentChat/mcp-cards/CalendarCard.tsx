import React from 'react';
import Box from '@mui/material/Box';
import EventIcon from '@mui/icons-material/Event';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCardColors } from './cardColors';
import { formatTimestamp } from './mcpCardHelpers';

export const CalendarCard: React.FC<{ data: Record<string, any>; hideHeader?: boolean }> = ({ data, hideHeader }) => {
  const c = useClaudeTokens();
  const { TC_BG, TC_BORDER, TC_HOVER, TC_HEADING, TC_BODY, TC_DIM, TC_SUCCESS } = useCardColors();
  const items: any[] = data.items || (Array.isArray(data) ? data : []);
  const single = !items.length ? data : null;

  if (single && (single.summary || single.start)) {
    const start = single.start?.dateTime || single.start?.date || single.start || '';
    const end = single.end?.dateTime || single.end?.date || single.end || '';
    return (
      <Box sx={{
        ...(hideHeader
          ? { overflow: 'hidden' }
          : { bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`, borderRadius: 1.5, mx: 1.5, my: 1, overflow: 'hidden' }),
      }}>
        {!hideHeader && (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 0.75,
            px: 1.5, py: 0.85, borderBottom: `1px solid ${TC_BORDER}`,
          }}>
            <EventIcon sx={{ fontSize: 14, color: TC_SUCCESS, opacity: 0.8 }} />
            <span style={{ color: TC_HEADING, fontSize: '0.78rem', fontWeight: 600, fontFamily: c.font.sans }}>
              {single.summary || '(no title)'}
            </span>
          </Box>
        )}
        <Box sx={{ px: 1.5, py: 1, display: 'flex', flexDirection: 'column', gap: 0.3 }}>
          {start && (
            <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
              <span style={{ color: TC_DIM, minWidth: 48, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Start</span>
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{formatTimestamp(start)}</span>
            </Box>
          )}
          {end && (
            <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
              <span style={{ color: TC_DIM, minWidth: 48, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>End</span>
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{formatTimestamp(end)}</span>
            </Box>
          )}
          {single.location && (
            <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
              <span style={{ color: TC_DIM, minWidth: 48, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Where</span>
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{single.location}</span>
            </Box>
          )}
          {single.description && (
            <Box sx={{ mt: 0.3, pt: 0.5, borderTop: `1px solid ${TC_BORDER}` }}>
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: c.font.sans, fontSize: '0.68rem', lineHeight: 1.5,
                color: TC_BODY,
              }}>
                {single.description.slice(0, 300)}
                {single.description.length > 300 ? '…' : ''}
              </pre>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  if (items.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.5, pt: 1 }}>
        {items.slice(0, 6).map((item: any, i: number) => (
          <Box key={i} sx={{
            bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`,
            borderRadius: 1.5, px: 1.25, py: 0.75,
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1,
            transition: 'background-color 0.15s',
            '&:hover': { bgcolor: TC_HOVER },
          }}>
            <span style={{ color: TC_HEADING, fontSize: '0.72rem', fontWeight: 500, fontFamily: c.font.sans }}>
              {item.summary || '(no title)'}
            </span>
            <span style={{ color: TC_DIM, fontSize: '0.6rem', flexShrink: 0, fontFamily: c.font.mono }}>
              {formatTimestamp(item.start?.dateTime || item.start?.date || item.start)}
            </span>
          </Box>
        ))}
        {items.length > 6 && (
          <span style={{ color: TC_DIM, fontSize: '0.64rem', fontStyle: 'italic', textAlign: 'center', display: 'block' }}>
            +{items.length - 6} more
          </span>
        )}
      </Box>
    );
  }

  return null;
};
