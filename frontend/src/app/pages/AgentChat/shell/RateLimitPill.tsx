import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import ScheduleIcon from '@mui/icons-material/Schedule';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearProviderRetrying, clearRateLimited, clearReconnectWait } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

/** Mid-turn CLI backoff pill (ENG-178): the provider 500/429'd and the CLI is silently waiting up
 * to tens of seconds; without this the card just sits dead. Auto-clears after the announced delay
 * plus slack, and each new retry event refreshes it. Same muted grammar as the rate-limit pill. */
export const ProviderRetryPill: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const pr = useAppSelector((s) => s.agents.sessions[sessionId]?.provider_retrying);

  useEffect(() => {
    if (!pr) return;
    const ms = Math.min(Math.max((pr.delay_ms ?? 15_000) + 15_000, 10_000), 120_000);
    const t = setTimeout(() => dispatch(clearProviderRetrying({ sessionId })), ms);
    return () => clearTimeout(t);
  }, [pr, sessionId, dispatch]);

  const label = pr?.attempt ? `Provider busy, retrying (attempt ${pr.attempt})` : 'Provider busy, retrying';
  const lastLabel = useRef(label);
  if (pr) lastLabel.current = label;

  return (
    <Fade in={!!pr} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        title="The AI provider had a hiccup; the agent is waiting it out and will continue on its own"
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
        <AutorenewIcon sx={{ fontSize: 14, animation: 'osw-retry-spin 1.6s linear infinite', '@keyframes osw-retry-spin': { to: { transform: 'rotate(360deg)' } } }} />
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500 }}>{lastLabel.current}</Typography>
      </Box>
    </Fade>
  );
};

// Muted, transient pill shown only after a real provider throttle outlasted the silent backoff. No card, no red, no CTA; it fades and auto-clears once the window should have passed. The "why" lives in the hover, not on the surface.
export const RateLimitPill: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const rl = useAppSelector((s) => s.agents.sessions[sessionId]?.rate_limited);

  useEffect(() => {
    if (!rl) return;
    const ms = Math.min(Math.max(rl.retry_after_s ?? 45, 5), 300) * 1000;
    const t = setTimeout(() => dispatch(clearRateLimited({ sessionId })), ms);
    return () => clearTimeout(t);
  }, [rl, sessionId, dispatch]);

  const label = rl?.retry_after_s
    ? `Back ~${(() => {
        const d = new Date(Date.now() + rl.retry_after_s * 1000);
        return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      })()}`
    : 'Rate limited';
  // Hold the last text so the exit fade renders content, not a blank pill.
  const lastLabel = useRef(label);
  if (rl) lastLabel.current = label;

  return (
    <Fade in={!!rl} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        title="Your plan hit its rate limit, it'll resume on its own"
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
        <ScheduleIcon sx={{ fontSize: 14 }} />
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500 }}>{lastLabel.current}</Typography>
      </Box>
    </Fade>
  );
};

/** The connection dropped for longer than the in-turn retry ladder covers, so the turn is PARKED
 * rather than finished: it wakes itself on a widening schedule and continues where it left off.
 * This is the one pill that must NOT auto-clear on a short timer, because the wait it describes can
 * be fifteen minutes; an agent sitting silent that long is exactly what makes people force-quit and
 * lose the task. It clears when the next turn actually lands; if that frame never arrives it admits
 * it is still trying once the announced wait plus grace has passed, and gives up ten minutes later. */
export const ReconnectWaitPill: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const rw = useAppSelector((s) => s.agents.sessions[sessionId]?.reconnect_wait);
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    setOverdue(false);
    if (!rw) return;
    const graceMs = Math.min((rw.retry_in_s ?? 0) + 120, 30 * 60) * 1000;
    const t1 = setTimeout(() => setOverdue(true), graceMs);
    const t2 = setTimeout(() => dispatch(clearReconnectWait({ sessionId })), graceMs + 10 * 60_000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [rw, sessionId, dispatch]);

  const label = (() => {
    if (overdue) return 'Still trying to reconnect';
    const secs = rw?.retry_in_s ?? 0;
    if (!secs) return 'Connection lost, retrying';
    const mins = Math.round(secs / 60);
    return mins >= 1 ? `Connection lost, retrying in ~${mins} min` : 'Connection lost, retrying shortly';
  })();
  const lastLabel = useRef(label);
  if (rw) lastLabel.current = label;

  return (
    <Fade in={!!rw} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        title="Your work is saved. The agent is waiting for the connection and will pick up where it left off, with nothing for you to click."
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
        <AutorenewIcon sx={{ fontSize: 14, animation: 'osw-retry-spin 1.6s linear infinite', '@keyframes osw-retry-spin': { to: { transform: 'rotate(360deg)' } } }} />
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500 }}>{lastLabel.current}</Typography>
      </Box>
    </Fade>
  );
};
