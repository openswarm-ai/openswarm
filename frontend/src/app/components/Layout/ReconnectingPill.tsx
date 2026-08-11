import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import Grow from '@mui/material/Grow';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { backendReachable, onBackendReachability } from '@/shared/backendConnection';

// Honest "the local backend went away" state, so an unreachable backend never reads as a silent
// forever-spinner (ENG-242). The interceptor's background probe self-heals; this only tells the
// user what is happening while it does, and lets them force a reload if they are impatient.
const ReconnectingPill: React.FC = () => {
  const c = useClaudeTokens();
  const [reachable, setReachable] = useState(true);
  // Only show after a short grace so a normal ~4s backend respawn heals invisibly; the pill is
  // for the case that actually worried the user, a backend that stays gone.
  const [showable, setShowable] = useState(false);

  useEffect(() => {
    setReachable(backendReachable());
    return onBackendReachability(setReachable);
  }, []);

  useEffect(() => {
    if (reachable) { setShowable(false); return undefined; }
    const t = setTimeout(() => setShowable(true), 6000);
    return () => clearTimeout(t);
  }, [reachable]);

  const show = !reachable && showable;

  // Portal to body: `position: fixed` resolves against a transformed ancestor, not the viewport, and
  // AppShell sits inside one, so the pill rendered visibly off-centre (measured on a screenshot).
  // A flex row spanning the viewport does the centring. Grow animates with its own `transform`, which
  // silently overwrote a `translateX(-50%)` on the same element and left the pill half its width off
  // centre (measured: centre 834 vs viewport centre 700). No transform, nothing to clobber.
  return createPortal(
    <Box sx={{ position: 'fixed', bottom: 16, left: 0, right: 0, zIndex: 1400, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
    <Grow in={show} unmountOnExit>
      <Box
        onClick={() => window.location.reload()}
        role="button"
        aria-label="Reconnecting to OpenSwarm; click to reload"
        sx={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.75,
          py: 1,
          borderRadius: 999,
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
          background: c.bg.elevated,
          border: `1px solid ${c.border.strong}`,
          boxShadow: c.shadow.lg,
        } as object}
      >
        <CircularProgress size={14} sx={{ color: c.text.secondary }} />
        <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, fontWeight: 500 }}>
          Reconnecting to OpenSwarm…
        </Typography>
        <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>
          click to reload
        </Typography>
      </Box>
    </Grow>
    </Box>,
    document.body,
  );
};

export default ReconnectingPill;
