import React, { useEffect } from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearContextRecovered } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Muted, transient pill shown when the backend self-healed a context-overflow crash mid-turn (rebuilt the chat from its local copy and retried). Visible so the recovery isn't silent, calm so it doesn't read as an error; the "why" lives in the hover.
export const ContextRecoveredPill: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const cr = useAppSelector((s) => s.agents.sessions[sessionId]?.context_recovered);

  useEffect(() => {
    if (!cr) return;
    const t = setTimeout(() => dispatch(clearContextRecovered({ sessionId })), 12000);
    return () => clearTimeout(t);
  }, [cr, sessionId, dispatch]);

  return (
    <Fade in={!!cr} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        title="This chat's memory overflowed mid-reply. OpenSwarm recovered it and retried automatically; nothing was lost."
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.6,
          alignSelf: 'flex-start',
          mx: 2,
          mb: 1,
          px: 1.25,
          py: 0.5,
          borderRadius: 999,
          bgcolor: c.bg.secondary,
          color: c.text.tertiary,
        }}
      >
        <RestartAltIcon sx={{ fontSize: 14 }} />
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500 }}>Recovered and retried</Typography>
      </Box>
    </Fade>
  );
};
