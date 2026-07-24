import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import { AnimatePresence, motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createWorkflow } from '@/shared/state/workflowsSlice';

const OFFER_DONE_KEY = 'openswarm.schedule-offer.v1';

function offerAlreadyResolved(): boolean {
  try { return localStorage.getItem(OFFER_DONE_KEY) !== null; } catch { return false; }
}

// The user picks the rhythm, we never dictate it: each chip is one click to a real schedule.
const CADENCES: Array<{ key: string; label: string; confirm: string; repeat_unit: 'day' | 'week'; on_days: number[] }> = [
  { key: 'daily', label: 'Every morning', confirm: 'every morning at 9', repeat_unit: 'day', on_days: [] },
  { key: 'weekdays', label: 'Weekdays', confirm: 'weekdays at 9', repeat_unit: 'week', on_days: [1, 2, 3, 4, 5] },
  { key: 'weekly', label: 'Mondays', confirm: 'Mondays at 9', repeat_unit: 'week', on_days: [1] },
];

// The dependency beat: the first personalized starter that COMPLETES earns ONE offer to become a
// standing job. Reads as the agent proactively chiming in: bottom-center over the composer, dark
// chrome, spring entrance. The user picks the cadence (chips), never a preset shoved at them; the X
// or any chip resolves it forever (one-shot per install).
const ScheduleOfferToast: React.FC<{ dashboardId: string }> = ({ dashboardId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [resolved, setResolved] = useState(offerAlreadyResolved);
  const [confirmText, setConfirmText] = useState<string | null>(null);
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

  const accept = useCallback(async (cadence: typeof CADENCES[number]) => {
    if (!offer) return;
    try {
      await dispatch(createWorkflow({
        title: offer.title,
        description: 'Created from your first run during onboarding.',
        steps: [{ id: `step-${Date.now().toString(36)}`, text: offer.prompt, enabled: true }],
        schedule: { enabled: true, repeat_every: 1, repeat_unit: cadence.repeat_unit, on_days: cadence.on_days, hour: 9, minute: 0, timezone: 'local', ends_at: null, max_runs: null, runs_count: 0 },
        dashboard_id: dashboardId,
        model,
      })).unwrap();
      setConfirmText(`Done. It runs ${cadence.confirm}, tweak anything under Workflows.`);
      window.setTimeout(finishOffer, 5000);
    } catch {
      finishOffer();
    }
  }, [offer, dispatch, dashboardId, model, finishOffer]);

  const open = !resolved && (!!offer || !!confirmText);

  return (
    <AnimatePresence>
      {open && (
        <Box sx={{ position: 'fixed', bottom: 74, left: '50%', transform: 'translateX(-50%)', zIndex: 1400, pointerEvents: 'none' }}>
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            style={{
              pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', gap: 10,
              maxWidth: 'min(640px, 90vw)',
              padding: '10px 12px 10px 16px',
              borderRadius: 14,
              background: 'rgba(22,12,34,0.92)',
              backdropFilter: 'blur(20px) saturate(160%)',
              WebkitBackdropFilter: 'blur(20px) saturate(160%)',
              boxShadow: '0 12px 36px rgba(0,0,0,0.4)',
              color: 'rgba(255,255,255,0.92)',
            }}
          >
            {confirmText ? (
              <>
                <CheckRoundedIcon sx={{ fontSize: 17, color: '#4fdf9f', flexShrink: 0 }} />
                <Box sx={{ fontSize: '0.8125rem' }}>{confirmText}</Box>
              </>
            ) : (
              <>
                <AutoAwesomeRoundedIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
                <Box sx={{ fontSize: '0.8125rem', minWidth: 0 }}>
                  That worked. Want me to run "{offer?.title ?? ''}" on a schedule?
                </Box>
                <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                  {CADENCES.map((cad) => (
                    <Box
                      key={cad.key}
                      component="button"
                      onClick={() => { void accept(cad); }}
                      sx={{
                        border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.07)',
                        color: 'rgba(255,255,255,0.92)', borderRadius: '999px', px: 1.25, py: 0.4,
                        fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                        whiteSpace: 'nowrap', transition: 'background 120ms, border-color 120ms',
                        '&:hover': { background: `${c.accent.primary}30`, borderColor: c.accent.primary },
                      }}
                    >
                      {cad.label}
                    </Box>
                  ))}
                </Box>
                <IconButton size="small" onClick={finishOffer} sx={{ color: 'rgba(255,255,255,0.55)', p: 0.4, '&:hover': { color: '#fff' } }}>
                  <CloseIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </>
            )}
          </motion.div>
        </Box>
      )}
    </AnimatePresence>
  );
};

export default ScheduleOfferToast;
