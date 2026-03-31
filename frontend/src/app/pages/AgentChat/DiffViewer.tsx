import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import DifferenceIcon from '@mui/icons-material/Difference';
import { CodeDiff } from '@/components/tool-ui/code-diff';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';

const AGENTS_API = `${API_BASE}/agents`;

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
      const res = await fetch(`${AGENTS_API}/sessions/${sessionId}/diff`);
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
          <CodeDiff
            id={`diff-${sessionId}`}
            patch={diff}
            language="diff"
            diffStyle="unified"
            lineNumbers="visible"
          />
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
