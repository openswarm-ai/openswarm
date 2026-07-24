import React from 'react';
import Box from '@mui/material/Box';
import { motion } from 'framer-motion';
import { CalendarClock, Check } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createWorkflow } from '@/shared/state/workflowsSlice';
import type { PersonalizedAutomation } from '@/shared/state/settingsSlice';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

const DONE_KEY = 'openswarm.automations.v1';

// Cadence -> a real workflow schedule. Weekday = Mon-Fri (JS weekday Sun=0), weekly = Mondays, daily = every day.
function scheduleFor(cadence: string) {
  const base = { enabled: true, repeat_every: 1, hour: 9, minute: 0, timezone: 'local', ends_at: null, max_runs: null, runs_count: 0 };
  if (cadence === 'daily') return { ...base, repeat_unit: 'day' as const, on_days: [] as number[] };
  if (cadence === 'weekday') return { ...base, repeat_unit: 'week' as const, on_days: [1, 2, 3, 4, 5] };
  return { ...base, repeat_unit: 'week' as const, on_days: [1] };
}

const CADENCE_LABEL: Record<string, string> = { daily: 'daily at 9am', weekday: 'weekdays at 9am', weekly: 'Mondays at 9am' };

// Prep proposed routines worth automating for THIS user; each chip is one click to a real scheduled workflow. Falls back to a generic morning brief when prep gave none. One-shot per install (localStorage), so a returning user is never re-nagged.
const AutomationChips: React.FC<{ c: ClaudeTokens }> = ({ c }) => {
  const dispatch = useAppDispatch();
  const model = useAppSelector((s) => s.settings.data.default_model);
  const proposed = useAppSelector((s) => s.settings.data.personalized_automations ?? []);
  const items: PersonalizedAutomation[] = proposed.length > 0 ? proposed.slice(0, 3) : [
    { title: 'Morning brief', prompt: "Put together my morning brief: today's date, my location's weather, and top tech + world headlines. Keep it under 300 words and save it as a dated note on my dashboard.", cadence: 'daily' },
  ];

  const [scheduled, setScheduled] = React.useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}'); } catch { return {}; }
  });

  const schedule = React.useCallback(async (a: PersonalizedAutomation) => {
    try {
      await dispatch(createWorkflow({
        title: a.title,
        description: 'Suggested during onboarding.',
        steps: [{ id: `step-${Date.now().toString(36)}`, text: a.prompt, enabled: true }],
        schedule: scheduleFor(a.cadence),
        model,
      })).unwrap();
      setScheduled((prev) => {
        const next = { ...prev, [a.title]: true };
        try { localStorage.setItem(DONE_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    } catch { /* leave the chip in its offer state */ }
  }, [dispatch, model]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.7, mt: 0.7 }}>
      {items.map((a, i) => {
        const done = !!scheduled[a.title];
        return (
          <motion.button
            key={a.title}
            onClick={() => { if (!done) void schedule(a); }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 26, delay: 0.1 + i * 0.06 }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
              padding: '10px 14px', borderRadius: 11,
              border: `1px dashed ${done ? c.status.success : c.border.strong}`,
              background: done ? c.status.successBg : 'transparent',
              color: done ? c.status.success : c.text.secondary,
              fontSize: '0.875rem', fontWeight: 500,
              cursor: done ? 'default' : 'pointer', fontFamily: 'inherit',
            }}
          >
            {done
              ? <Check size={14} style={{ flexShrink: 0 }} />
              : <CalendarClock size={14} color={c.accent.primary} style={{ flexShrink: 0 }} />}
            {done ? `${a.title} scheduled, ${CADENCE_LABEL[a.cadence] ?? 'weekly'}` : `${a.title}, ${CADENCE_LABEL[a.cadence] ?? 'weekly'}`}
          </motion.button>
        );
      })}
    </Box>
  );
};

export default AutomationChips;
