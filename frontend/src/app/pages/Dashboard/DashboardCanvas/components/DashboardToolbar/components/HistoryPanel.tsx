import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import CircularProgress from '@mui/material/CircularProgress';
import SearchIcon from '@mui/icons-material/Search';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { formatRelativeTime } from '@/app/pages/Dashboard/utils/formatRelativeTime';

interface HistoryPanelProps {
  historyInputRef: React.RefObject<HTMLInputElement>;
  historyListRef: React.RefObject<HTMLDivElement>;
  historyQuery: string;
  onQueryChange: (q: string) => void;
  historySearch: {
    results: Array<{ id: string; name: string; closed_at: string | null }>;
    loading: boolean;
  };
  onScroll: () => void;
  onSelect: (sessionId: string) => void;
  c: ClaudeTokens;
}

export default function HistoryPanel({
  historyInputRef, historyListRef, historyQuery, onQueryChange,
  historySearch, onScroll, onSelect, c,
}: HistoryPanelProps) {
  return (
    <div style={{ width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
        <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
        <InputBase
          inputRef={historyInputRef}
          value={historyQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search past chats..."
          sx={{
            flex: 1,
            fontSize: '0.85rem',
            color: c.text.primary,
            fontFamily: c.font.sans,
            '& input::placeholder': { color: c.text.ghost, opacity: 1 },
          }}
        />
        {historySearch.loading && historySearch.results.length === 0 && (
          <CircularProgress size={16} sx={{ color: c.text.muted }} />
        )}
      </Box>
      <Box
        ref={historyListRef}
        onScroll={onScroll}
        sx={{
          maxHeight: 320,
          overflow: 'auto',
          borderTop: `1px solid ${c.border.subtle}`,
          '&::-webkit-scrollbar': { width: 4 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          scrollbarWidth: 'thin',
          scrollbarColor: `${c.border.medium} transparent`,
        }}
      >
        {historySearch.results.length === 0 && !historySearch.loading ? (
          <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
            <Typography sx={{ fontSize: '0.82rem', color: c.text.muted }}>
              {historyQuery ? 'No matching chats' : 'No chat history yet'}
            </Typography>
          </Box>
        ) : (
          <>
            {historySearch.results.map((entry) => (
              <Box
                key={entry.id}
                onClick={() => onSelect(entry.id)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1.5,
                  px: 1.5,
                  py: 0.9,
                  cursor: 'pointer',
                  transition: 'background-color 0.1s',
                  '&:hover': { bgcolor: c.bg.elevated },
                }}
              >
                <Typography
                  sx={{
                    fontSize: '0.82rem',
                    fontWeight: 500,
                    color: c.text.primary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {entry.name}
                </Typography>
                <Typography
                  sx={{
                    fontSize: '0.7rem',
                    color: c.text.ghost,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatRelativeTime(entry.closed_at)}
                </Typography>
              </Box>
            ))}
            {historySearch.loading && historySearch.results.length > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}>
                <CircularProgress size={16} sx={{ color: c.text.muted }} />
              </Box>
            )}
          </>
        )}
      </Box>
    </div>
  );
}
