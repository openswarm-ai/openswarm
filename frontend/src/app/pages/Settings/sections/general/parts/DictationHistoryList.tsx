import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { readDictationHistory, clearDictationHistory, DictationHistoryEntry } from '@/shared/voice/voiceHistory';

// The last dictations with one-click copy: rescue for a transcript that landed in the wrong field.
const DictationHistoryList: React.FC = () => {
  const c = useClaudeTokens();
  const [entries, setEntries] = useState<DictationHistoryEntry[]>(readDictationHistory);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  if (entries.length === 0) {
    return <Typography sx={{ color: c.text.ghost, fontSize: '0.8125rem' }}>Nothing dictated yet.</Typography>;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, width: '100%' }}>
      {entries.slice(0, 8).map((e) => (
        <Box key={e.at} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' } }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap sx={{ color: c.text.primary, fontSize: '0.8125rem' }}>{e.text}</Typography>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.6875rem' }}>
              {new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {e.target}
            </Typography>
          </Box>
          <Tooltip title={copiedAt === e.at ? 'Copied' : 'Copy'} placement="left">
            <IconButton
              size="small"
              onClick={() => { void navigator.clipboard.writeText(e.text); setCopiedAt(e.at); }}
              sx={{ color: c.text.muted }}
            >
              <ContentCopyRoundedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Box>
      ))}
      <Button
        size="small"
        onClick={() => { clearDictationHistory(); setEntries([]); }}
        sx={{ alignSelf: 'flex-start', mt: 0.5, textTransform: 'none', fontSize: '0.75rem', color: c.text.muted }}
      >
        Clear history
      </Button>
    </Box>
  );
};

export default DictationHistoryList;
