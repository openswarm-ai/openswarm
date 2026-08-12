import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import Grow from '@mui/material/Grow';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { backendReachable, onBackendReachability } from '@/shared/backendConnection';

// Honest "the local backend went away" state, so an unreachable backend never reads as a silent
// forever-spinner (ENG-242). The interceptor's background probe self-heals; this only tells the
// user what is happening while it does, and lets them force a reload if they are impatient.
//
// It also CLOSES the story. The pill used to just vanish when the backend came back, which leaves
// the one question the user actually has unanswered: did it work, or did the notice give up? A brief
// "Reconnected" is the whole feature, deliberately not a permanent status bar: a surface that is
// always there becomes furniture nobody reads, and the interesting states are rare by design.
const RECONNECTED_HOLD_MS = 2600;

const ReconnectingPill: React.FC = () => {
  const c = useClaudeTokens();
  const [reachable, setReachable] = useState(true);
  // Only show after a short grace so a normal ~4s backend respawn heals invisibly; the pill is
  // for the case that actually worried the user, a backend that stays gone.
  const [showable, setShowable] = useState(false);
  const [justHealed, setJustHealed] = useState(false);
  // Only confirm a recovery the user was actually told about; a heal nobody saw needs no receipt.
  const wasVisibleRef = useRef(false);

  useEffect(() => {
    setReachable(backendReachable());
    return onBackendReachability(setReachable);
  }, []);

  useEffect(() => {
    if (reachable) { setShowable(false); return undefined; }
    const t = setTimeout(() => setShowable(true), 6000);
    return () => clearTimeout(t);
  }, [reachable]);

  const showProblem = !reachable && showable;

  useEffect(() => {
    if (showProblem) { wasVisibleRef.current = true; return undefined; }
    if (!reachable || !wasVisibleRef.current) return undefined;
    wasVisibleRef.current = false;
    setJustHealed(true);
    const t = setTimeout(() => setJustHealed(false), RECONNECTED_HOLD_MS);
    return () => clearTimeout(t);
  }, [showProblem, reachable]);

  const show = showProblem || justHealed;

  // Portal to body: `position: fixed` resolves against a transformed ancestor, not the viewport, and
  // AppShell sits inside one, so the pill rendered visibly off-centre (measured on a screenshot).
  // A flex row spanning the viewport does the centring. Grow animates with its own `transform`, which
  // silently overwrote a `translateX(-50%)` on the same element and left the pill half its width off
  // centre (measured: centre 834 vs viewport centre 700). No transform, nothing to clobber.
  return createPortal(
    <Box sx={{ position: 'fixed', bottom: 16, left: 0, right: 0, zIndex: 1400, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
    {/* Asymmetric on purpose: the pill arrives quickly because it is answering a question you already
        have, and leaves slowly so the resolution registers as calm rather than a flicker. One element
        that changes its contents, never two pills swapping, so nothing on screen appears to move. */}
    <Grow in={show} unmountOnExit timeout={{ enter: 180, exit: 420 }}>
      <Box
        onClick={showProblem ? () => window.location.reload() : undefined}
        role={showProblem ? 'button' : 'status'}
        aria-label={showProblem ? 'Reconnecting to OpenSwarm; click to reload' : 'Reconnected to OpenSwarm'}
        sx={{
          pointerEvents: showProblem ? 'auto' : 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.75,
          py: 1,
          borderRadius: 999,
          cursor: showProblem ? 'pointer' : 'default',
          WebkitAppRegion: 'no-drag',
          background: c.bg.elevated,
          border: `1px solid ${c.border.strong}`,
          boxShadow: c.shadow.lg,
        } as object}
      >
        {showProblem ? (
          <>
            <CircularProgress size={14} sx={{ color: c.text.secondary }} />
            <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, fontWeight: 500 }}>
              Reconnecting to OpenSwarm…
            </Typography>
            <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>
              click to reload
            </Typography>
          </>
        ) : (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            animation: 'oswSettle 240ms ease-out',
            '@keyframes oswSettle': {
              from: { opacity: 0 },
              to: { opacity: 1 },
            },
          }}>
            <CheckRoundedIcon sx={{ fontSize: 16, color: c.status.success }} />
            <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, fontWeight: 500 }}>
              Reconnected
            </Typography>
          </Box>
        )}
      </Box>
    </Grow>
    </Box>,
    document.body,
  );
};

export default ReconnectingPill;
