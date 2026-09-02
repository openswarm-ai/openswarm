import React, { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearSelfHeal, SelfHealKind } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const COPY: Record<SelfHealKind, { text: string; why: (outstandingS: number | null) => string }> = {
  context_overflow: {
    text: 'Recovered and retried',
    why: () => "This chat's memory overflowed mid-reply. OpenSwarm recovered it and retried automatically; nothing was lost.",
  },
  tool_restarted: {
    text: 'A stuck tool was restarted; continuing',
    why: (s) => `A built-in tool stopped answering for ${Math.round(s ?? 0)} seconds, so OpenSwarm restarted it and the agent is redoing that step.`,
  },
  cli_compacted: {
    text: 'Older turns summarized to free up room',
    why: () => 'The model summarized its own earlier turns to stay within its context window; nothing you sent was lost.',
  },
};

// Muted, transient pill for a mid-turn self-heal (context rebuilt, a wedged tool restarted, the model compacting its own history). Visible so the recovery isn't silent, calm so it doesn't read as an error; the "why" lives in the hover.
export const SelfHealPill: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const heal = useAppSelector((s) => s.agents.selfHeals[sessionId]);

  useEffect(() => {
    if (!heal) return;
    const t = setTimeout(() => dispatch(clearSelfHeal({ sessionId })), 12000);
    return () => clearTimeout(t);
  }, [heal, sessionId, dispatch]);

  // Hold the last copy so the exit fade renders words, not a blank pill.
  const copy = heal ? { text: COPY[heal.kind].text, why: COPY[heal.kind].why(heal.outstanding_s) } : null;
  const lastCopy = useRef(copy ?? { text: '', why: '' });
  if (copy) lastCopy.current = copy;

  return (
    <Fade in={!!heal} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        title={lastCopy.current.why}
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
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500 }}>{lastCopy.current.text}</Typography>
      </Box>
    </Fade>
  );
};
