import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Grow from '@mui/material/Grow';
import Typography from '@mui/material/Typography';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { openSettingsCard } from '@/shared/state/dashboardLayoutSlice';
import { hasModelConnected as selectHasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { fetchSettings } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import { onBackendReachability } from '@/shared/backendConnection';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';
import { modelErrorState } from '@/app/components/Layout/modelErrorState';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// The old top banner for "no model / offline / backend gone" was a dead end that could also lie:
// a network blip failed the settings+models fetches, nothing ever re-fetched, and the red wall sat
// there claiming models were unconfigured until the user happened to open Settings (Haik's report,
// 2026-08-16). This is its replacement: the update-pill's quiet-card shape in red, whole card
// clickable into Settings -> Models, and it heals ITSELF because recovery re-runs the fetches.
const ModelErrorPill: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [hovered, setHovered] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const settingsKnown = useAppSelector((s) => s.settings.loaded);
  const settingsSettled = useAppSelector((s) => s.settings.settled);
  const modelsLoaded = useAppSelector((s) => s.models.loaded && !s.models.failed);
  const hasModel = useAppSelector(selectHasModelConnected);
  const freeTrialArmSettled = useAppSelector((s) => s.settings.freeTrialArmSettled);
  const freeTrialActive = useAppSelector((s) => {
    const d = s.settings.data as any;
    return !!(d && d.connection_mode === 'free-trial' && d.free_trial_token);
  });
  const freeTrialSpent = useAppSelector((s) => {
    const d = s.settings.data as any;
    return !!(d && (d.free_trial_runs_limit ?? 0) > 0 && d.free_trial_remaining === 0 && d.connection_mode !== 'free-trial');
  });
  // Sit below the update pill only while it actually owns the corner.
  const updatePillShowing = useAppSelector((s) => s.update.status === 'downloaded');

  const state = modelErrorState({
    isOnline, settingsKnown, settingsSettled, modelsOk: modelsLoaded,
    hasModel, freeTrialArmSettled, freeTrialActive, freeTrialSpent,
  });

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // The self-heal: any recovery signal re-runs the fetches whose stale failure kept the error up.
  useEffect(() => {
    const refetch = () => {
      dispatch(fetchSettings());
      dispatch(fetchModels());
    };
    const onOnline = () => refetch();
    window.addEventListener('online', onOnline);
    const offReach = onBackendReachability((reachable) => { if (reachable) refetch(); });
    return () => {
      window.removeEventListener('online', onOnline);
      offReach();
    };
  }, [dispatch]);

  // A router bounce restores models while the backend stays reachable, so no recovery event fires; poll gently while the error owns the corner.
  useEffect(() => {
    if (state !== 'no-model') return;
    const t = setInterval(() => {
      dispatch(fetchSettings());
      dispatch(fetchModels());
    }, 30000);
    return () => clearInterval(t);
  }, [state, dispatch]);

  const clickable = state === 'no-model';
  const title =
    state === 'offline' ? 'No internet connection'
    : state === 'backend' ? 'OpenSwarm backend unreachable'
    : 'No AI model connected';
  const sub =
    state === 'offline' ? "Agents can't reach AI models"
    : state === 'backend' ? 'Reconnecting…'
    : 'Configure models in Settings';

  return (
    <Grow in={state !== null} unmountOnExit>
      <Box
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={clickable ? () => dispatch(openSettingsCard({ tab: 'models' })) : undefined}
        role={clickable ? 'button' : undefined}
        aria-label={title}
        sx={{
          position: 'fixed',
          top: updatePillShowing ? 66 : 14,
          right: 16,
          zIndex: 1399,
          WebkitAppRegion: 'no-drag',
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          pl: 1.25,
          pr: 1.5,
          py: 1,
          borderRadius: '12px',
          bgcolor: c.bg.surface,
          border: `1px solid ${hovered && clickable ? 'rgba(239, 68, 68, 0.75)' : 'rgba(239, 68, 68, 0.45)'}`,
          boxShadow: hovered && clickable ? c.shadow.lg : c.shadow.md,
          cursor: clickable ? 'pointer' : 'default',
          userSelect: 'none',
          transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease, top 0.18s ease',
          transform: hovered && clickable ? 'translateY(-1px)' : 'none',
        }}
      >
        <ErrorSlime size={22} />
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.25, color: '#ef4444', whiteSpace: 'nowrap' }}>
            {title}
          </Typography>
          <Typography sx={{ fontSize: '0.6875rem', lineHeight: 1.3, color: c.text.tertiary, whiteSpace: 'nowrap' }}>
            {sub}
          </Typography>
        </Box>
        {clickable && (
          <ArrowForwardIcon
            sx={{
              fontSize: 16,
              color: c.text.tertiary,
              ml: 0.5,
              flexShrink: 0,
              transition: 'transform 0.18s ease',
              transform: hovered ? 'translateX(2px)' : 'none',
            }}
          />
        )}
      </Box>
    </Grow>
  );
};

export default ModelErrorPill;
