import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import MicIcon from '@mui/icons-material/Mic';
import { useVoice } from '@/shared/voice/VoiceDictationContext';
import HelpPanel from './HelpPanel';

/** Top-right desktop pill: Help opens the help panel (ask, report a bug, docs); the mic dictates (local whisper) into the focused field. */
function HelpPill(): React.ReactElement {
  const { state, pct, pressStart, pressEnd } = useVoice();
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const recording = state === 'recording';
  const transcribing = state === 'transcribing';
  const preparing = state === 'preparing';
  const busy = transcribing || preparing;

  // Outside click / Esc closes the panel; listeners only live while it's open.
  useEffect(() => {
    if (!helpOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setHelpOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setHelpOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [helpOpen]);

  return (
    <Box ref={rootRef} sx={{ position: 'relative' }}>
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
        onClick={() => setHelpOpen((v) => !v)}
      >
        <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.72)', fontWeight: 500 }}>
          {recording ? 'Listening' : transcribing ? 'Transcribing' : preparing ? `Preparing ${pct}%` : 'Help'}
        </Typography>
        <Tooltip title={recording ? 'Stop dictation' : preparing ? 'Downloading voice model' : 'Dictate (F5)'} placement="bottom" arrow>
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
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
    </Box>
  );
}

export default HelpPill;
