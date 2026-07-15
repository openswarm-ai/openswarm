import React, { useCallback, useMemo, useState } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createWorkflow } from '@/shared/state/workflowsSlice';

const OFFER_DONE_KEY = 'openswarm.schedule-offer.v1';

function offerAlreadyResolved(): boolean {
  try { return localStorage.getItem(OFFER_DONE_KEY) !== null; } catch { return false; }
}

// The dependency beat: the first personalized starter that COMPLETES earns one offer to become a standing weekly job. One-shot per install; accept creates a real scheduled workflow (Mondays 9am), dismiss never asks again.
const ScheduleOfferToast: React.FC<{ dashboardId: string }> = ({ dashboardId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [resolved, setResolved] = useState(offerAlreadyResolved);
  const [scheduled, setScheduled] = useState(false);
  const starters = useAppSelector((s) => s.settings.data.personalized_starters ?? []);
  const sessions = useAppSelector((s) => s.agents.sessions);
  const model = useAppSelector((s) => s.settings.data.default_model);

  const offer = useMemo(() => {
    if (resolved || starters.length === 0) return null;
    const prompts = new Map(starters.map((st) => [st.prompt.trim(), st]));
    for (const session of Object.values(sessions)) {
      if (session.status !== 'completed') continue;
      const first = session.messages?.find((m) => m.role === 'user');
      const text = typeof first?.content === 'string' ? first.content.trim() : '';
      const starter = prompts.get(text);
      if (starter) return starter;
    }
    return null;
  }, [resolved, starters, sessions]);

  const finishOffer = useCallback(() => {
    try { localStorage.setItem(OFFER_DONE_KEY, new Date().toISOString()); } catch {}
    setResolved(true);
  }, []);

  const accept = useCallback(async () => {
    if (!offer) return;
    try {
      await dispatch(createWorkflow({
        title: offer.title,
        description: 'Created from your first run during onboarding.',
        steps: [{ id: `step-${Date.now().toString(36)}`, text: offer.prompt, enabled: true }],
        schedule: { enabled: true, repeat_every: 1, repeat_unit: 'week', on_days: [1], hour: 9, minute: 0, timezone: 'local', ends_at: null, max_runs: null, runs_count: 0 },
        dashboard_id: dashboardId,
        model,
      })).unwrap();
      setScheduled(true);
      window.setTimeout(finishOffer, 5000);
    } catch {
      finishOffer();
    }
  }, [offer, dispatch, dashboardId, model, finishOffer]);

  return (
    <Snackbar
      open={!resolved && (!!offer || scheduled)}
      autoHideDuration={null}
      // Clickaway would kill the offer before it is read; only the X or a button resolves it.
      onClose={(event, reason) => { if (reason !== 'clickaway') finishOffer(); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="success"
        sx={{
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          '& .MuiAlert-action': { alignItems: 'center', pt: 0 },
        }}
        action={
          scheduled ? undefined : (
            <>
              <Button size="small" onClick={() => { void accept(); }} sx={{ color: c.accent.primary, fontWeight: 700 }}>
                Every Monday
              </Button>
              <IconButton size="small" onClick={finishOffer} sx={{ color: c.text.tertiary }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </>
          )
        }
      >
        {scheduled
          ? 'Scheduled for Mondays at 9am. Manage it under Workflows.'
          : `Nice, that worked. Want me to run "${offer?.title ?? ''}" every Monday at 9am?`}
      </Alert>
    </Snackbar>
  );
};

export default ScheduleOfferToast;
