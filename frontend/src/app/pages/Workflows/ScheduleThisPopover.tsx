// Minimum-steps-to-value entry point: from any open chat, hit "Schedule"
// in the header, pick one of four presets, and we materialize a workflow
// seeded with source_session_id (so it inherits the chat's tool surface
// + steps via the existing /workflows/create path). "Custom..." opens a
// LOCAL draft card instead of immediately POSTing /workflows/create, so
// users who change their mind don't leave behind an orphan workflow.

import React, { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import InputBase from '@mui/material/InputBase';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createWorkflow, openWorkflowCard, type ScheduleConfig, type Workflow } from '@/shared/state/workflowsSlice';
import { addWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { defaultSchedule } from './scheduleUtils';

type Preset = {
  label: string;
  hint: string;
  build: () => Partial<ScheduleConfig>;
};

const PRESETS: Preset[] = [
  { label: 'Every day at 9am', hint: 'Daily standup, morning report', build: () => ({ enabled: true, repeat_unit: 'day', repeat_every: 1, hour: 9, minute: 0 }) },
  { label: 'Weekdays at 9am', hint: 'Mon to Fri', build: () => ({ enabled: true, repeat_unit: 'week', repeat_every: 1, on_days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }) },
  { label: 'Every Monday at 9am', hint: 'Weekly check-in', build: () => ({ enabled: true, repeat_unit: 'week', repeat_every: 1, on_days: [1], hour: 9, minute: 0 }) },
  { label: 'Every month on the 1st', hint: 'Monthly summary, billing report', build: () => ({ enabled: true, repeat_unit: 'month', repeat_every: 1, hour: 9, minute: 0 }) },
];

interface Props {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
  // Hook so the caller can show "Workflow created" feedback inline.
  onCreated?: (workflowId: string) => void;
  // Auto-suggest path: when the caller detected time-words and wants to
  // pre-fill the popover with that exact schedule, the first preset
  // shown becomes "Use suggestion: <label>" and is set as the default.
  prefillSchedule?: ScheduleConfig | null;
  prefillLabel?: string | null;
}

export default function ScheduleThisPopover({ anchorEl, onClose, sessionId, sessionName, onCreated, prefillSchedule, prefillLabel }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [title, setTitle] = useState<string>(sessionName || 'Untitled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflows = useAppSelector((s) => s.workflows.items);
  // Workflow cards only render inside the Dashboard canvas. When this
  // popover is opened from somewhere else (Apps editor, etc.), Custom...
  // would silently drop the user on a non-canvas page with no visible
  // editor — see this session's chat history. Look up the session's
  // dashboard so we can navigate there before opening the draft.
  const sessionDashboardId = useAppSelector(
    (s) => sessionId ? s.agents.sessions[sessionId]?.dashboard_id : null,
  );

  // Dup-detect: a chat session can only sanely have one schedule attached.
  // If we find one already, offer "Open existing" instead of silently
  // creating a duplicate that fires twice.
  const existing = useMemo<Workflow | null>(() => {
    if (!sessionId) return null;
    for (const w of Object.values(workflows)) {
      if (w.source_session_id === sessionId) return w;
    }
    return null;
  }, [workflows, sessionId]);

  const submit = useCallback(async (preset: Preset) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const schedule: ScheduleConfig = { ...defaultSchedule(), ...preset.build() };
      const result = await dispatch(createWorkflow({
        title,
        source_session_id: sessionId,
        schedule,
      } as Partial<Workflow>));
      if (createWorkflow.fulfilled.match(result)) {
        const wf = result.payload as Workflow;
        dispatch(addWorkflowCard({ workflowId: wf.id, sourceSessionId: sessionId }));
        dispatch(openWorkflowCard({ workflowId: wf.id, view: 'saved' }));
        onCreated?.(wf.id);
        onClose();
      } else {
        setError('Create failed. Try again.');
      }
    } catch (e) {
      setError((e as Error)?.message || 'Create failed.');
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, sessionId, title, onClose, onCreated]);

  const openCustom = useCallback(() => {
    // Open a local draft. NO backend create yet — the workflow only
    // exists on disk once the user clicks Save in the editor. Closing
    // the draft card from here leaves nothing behind (the "orphan"
    // bug from the previous create-then-edit flow).
    const tempId = `draft-${sessionId}-${Date.now()}`;
    dispatch(addWorkflowCard({ workflowId: tempId, sourceSessionId: sessionId }));
    dispatch(openWorkflowCard({
      workflowId: tempId,
      sourceSessionId: sessionId,
      view: 'preview',
      draft: {
        title,
        description: 'Scheduled from chat. Edit anytime.',
        steps: [{ id: 'step-1', text: '' }],
        schedule: { ...defaultSchedule() },
      } as Partial<Workflow>,
    }));
    // If the user opened this popover from somewhere other than the
    // dashboard canvas (e.g. the Apps editor), the draft card we just
    // created is invisible because <WorkflowCard /> is only rendered on
    // /dashboard/<id>. Navigate there so the user lands on the editable
    // card. No-op when already on a dashboard route.
    if (sessionDashboardId && !location.pathname.startsWith('/dashboard/')) {
      navigate(`/dashboard/${sessionDashboardId}`);
    }
    onClose();
  }, [dispatch, sessionId, title, onClose, sessionDashboardId, navigate, location.pathname]);

  const openExisting = useCallback(() => {
    if (!existing) return;
    dispatch(addWorkflowCard({ workflowId: existing.id, sourceSessionId: sessionId }));
    dispatch(openWorkflowCard({ workflowId: existing.id, view: 'saved' }));
    onClose();
  }, [dispatch, existing, sessionId, onClose]);

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 320, p: 1.25 } } }}
    >
      <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mb: 0.75 }}>
        SCHEDULE THIS CHAT
      </Typography>
      {existing && (
        <Box sx={{
          display: 'flex', flexDirection: 'column', gap: 0.4,
          px: 1, py: 0.75, mb: 0.75,
          borderRadius: `${c.radius.md}px`,
          bgcolor: c.status.warningBg || c.bg.elevated,
          border: `1px solid ${(c.status.warning || c.text.muted) + '60'}`,
        }}>
          <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.text.primary }}>
            This chat is already scheduled.
          </Typography>
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>
            &quot;{existing.title}&quot; was made from this conversation. Adding another would fire twice.
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
            <Box onClick={openExisting} role="button" sx={{
              fontSize: '0.74rem', fontWeight: 600, color: c.accent.primary,
              cursor: 'pointer', px: 0.75, py: 0.3, borderRadius: `${c.radius.md}px`,
              bgcolor: c.accent.primary + '14', border: `1px solid ${c.accent.primary}40`,
              '&:hover': { bgcolor: c.accent.primary + '22' },
            }}>Open existing →</Box>
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
        <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary }}>Name:</Typography>
        <InputBase
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          sx={{ flex: 1, fontSize: '0.85rem', color: c.text.primary, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 0.75, py: 0.3 }}
        />
      </Box>
      {prefillSchedule && prefillLabel && (
        <Box
          role="button"
          onClick={() => submit({
            label: prefillLabel,
            hint: 'Detected from your conversation',
            build: () => prefillSchedule as Partial<ScheduleConfig>,
          })}
          sx={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
            px: 1, py: 0.7, borderRadius: `${c.radius.md}px`,
            mb: 0.5,
            border: `1px solid ${c.accent.primary}55`,
            bgcolor: c.accent.primary + '14',
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.5 : 1,
            '&:hover': { bgcolor: c.accent.primary + '22' },
          }}>
          <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.accent.primary, letterSpacing: '0.04em' }}>SUGGESTED</Typography>
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 600, color: c.text.primary }}>{prefillLabel}</Typography>
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>Detected from your last reply</Typography>
        </Box>
      )}
      {PRESETS.map((p) => (
        <Box
          key={p.label}
          role="button"
          onClick={() => submit(p)}
          sx={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
            px: 1, py: 0.6, borderRadius: `${c.radius.md}px`,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.5 : 1,
            '&:hover': { bgcolor: c.bg.elevated },
          }}>
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 600, color: c.text.primary }}>{p.label}</Typography>
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>{p.hint}</Typography>
        </Box>
      ))}
      <Box
        role="button"
        onClick={openCustom}
        sx={{
          mt: 0.5, borderTop: `1px solid ${c.border.subtle}`,
          px: 1, py: 0.7, borderRadius: `${c.radius.md}px`,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.5 : 1,
          '&:hover': { bgcolor: c.bg.elevated },
        }}>
        <Typography sx={{ fontSize: '0.84rem', fontWeight: 600, color: c.accent.primary }}>Custom…</Typography>
        <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>Open the editor without saving yet</Typography>
      </Box>
      {error && (
        <Typography sx={{ mt: 0.5, fontSize: '0.74rem', color: c.status.error }}>{error}</Typography>
      )}
    </Popover>
  );
}
