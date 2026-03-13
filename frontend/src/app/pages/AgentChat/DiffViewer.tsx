import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import DifferenceIcon from '@mui/icons-material/Difference';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const API_BASE = `http://${window.location.hostname}:8324/api/agents`;

interface Props {
  sessionId: string;
}

const DiffViewer: React.FC<Props> = ({ sessionId }) => {
  const c = useClaudeTokens();
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const fetchDiff = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionId}/diff`);
      const data = await res.json();
      setDiff(data.diff || '');
    } catch {
      setDiff('Failed to fetch diff');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (open) fetchDiff();
  }, [open, sessionId]);

  if (!open) {
    return (
      <Tooltip title="View changes">
        <IconButton onClick={() => setOpen(true)} sx={{ color: c.text.tertiary }}>
          <DifferenceIcon />
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <Box
      sx={{
        width: 400,
        flexShrink: 0,
        boxShadow: '-1px 0 4px rgba(0,0,0,0.04)',
        bgcolor: c.bg.surface,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          borderBottom: `0.5px solid ${c.border.medium}`,
          bgcolor: c.bg.secondary,
        }}
      >
        <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.85rem' }}>
          Worktree Changes
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={fetchDiff} sx={{ color: c.text.tertiary }}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <IconButton size="small" onClick={() => setOpen(false)} sx={{ color: c.text.tertiary }}>
            <Typography sx={{ fontSize: '0.85rem' }}>×</Typography>
          </IconButton>
        </Box>
      </Box>
      <Box
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 1.5,
          '&::-webkit-scrollbar': { width: 5, height: 5 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: c.border.medium,
            borderRadius: 3,
            '&:hover': { background: c.border.strong },
          },
          scrollbarWidth: 'thin',
          scrollbarColor: `${c.border.medium} transparent`,
        }}
      >
        {loading ? (
          <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem' }}>Loading...</Typography>
        ) : diff ? (
          <pre
            style={{
              margin: 0,
              fontSize: '0.72rem',
              fontFamily: c.font.mono,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {diff.split('\n').map((line, i) => {
              let color = c.text.muted;
              if (line.startsWith('+') && !line.startsWith('+++')) color = c.status.success;
              else if (line.startsWith('-') && !line.startsWith('---')) color = c.status.error;
              else if (line.startsWith('@@')) color = c.accent.primary;
              else if (line.startsWith('diff ') || line.startsWith('index ')) color = c.text.tertiary;

              return (
                <span key={i} style={{ color }}>
                  {line}
                  {'\n'}
                </span>
              );
            })}
          </pre>
        ) : (
          <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem' }}>
            No changes detected in the worktree.
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export default DiffViewer;
