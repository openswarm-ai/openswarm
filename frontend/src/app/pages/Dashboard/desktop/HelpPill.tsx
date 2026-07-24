import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import MicIcon from '@mui/icons-material/Mic';
import { useAppDispatch } from '@/shared/hooks';
import { addBrowserCard } from '@/shared/state/dashboardLayoutSlice';
import { useVoice } from '@/shared/voice/VoiceDictationContext';

const HELP_URL = 'https://openswarm.com';

/** Top-right desktop pill: Help opens the docs; the mic dictates (local whisper) into the focused field. */
function HelpPill(): React.ReactElement {
  const dispatch = useAppDispatch();
  const { state, pct, pressStart, pressEnd } = useVoice();
  const recording = state === 'recording';
  const transcribing = state === 'transcribing';
  const preparing = state === 'preparing';
  const busy = transcribing || preparing;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        height: 30,
        pl: 1.5,
        pr: 1,
        borderRadius: 999,
        background: recording ? 'rgba(150,30,40,0.72)' : 'rgba(22,12,34,0.66)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background 0.2s ease',
      }}
      onClick={() => dispatch(addBrowserCard({ url: HELP_URL }))}
    >
      <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.72)', fontWeight: 500 }}>
        {recording ? 'Listening' : transcribing ? 'Transcribing' : preparing ? `Preparing ${pct}%` : 'Help'}
      </Typography>
      <Tooltip title={recording ? 'Stop dictation' : preparing ? 'Downloading voice model' : 'Dictate (Cmd+Shift+D)'} placement="bottom" arrow>
        <Box
          sx={{ display: 'flex', alignItems: 'center', color: recording ? '#fff' : 'rgba(255,255,255,0.55)' }}
          onPointerDown={(e) => { e.stopPropagation(); if (!busy) pressStart(); }}
          onPointerUp={(e) => { e.stopPropagation(); pressEnd(); }}
          onPointerLeave={() => pressEnd()}
          onClick={(e) => e.stopPropagation()}
        >
          {busy
            ? <CircularProgress size={13} thickness={5} sx={{ color: 'rgba(255,255,255,0.7)' }} />
            : recording
              ? <MicIcon sx={{ fontSize: 16 }} />
              : <MicNoneOutlinedIcon sx={{ fontSize: 15 }} />}
        </Box>
      </Tooltip>
    </Box>
  );
}

export default HelpPill;
