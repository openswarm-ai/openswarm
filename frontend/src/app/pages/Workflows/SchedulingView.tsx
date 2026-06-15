// Image #49: natural-language schedule composer.
// Header morphs into `[trash] Cancel task scheduling`. Body shows a soft
// frame around the read-only step list, an agent reply bubble asking for
// the cadence, and a chat-style composer at the bottom. On submit we
// hit /workflows/{id}/parse-schedule (aux LLM), surface the parsed
// ScheduleConfig in a confirmation modal (the "always ask permission"
// stand-in for the schedule_workflow tool call), and PATCH on confirm.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { updateWorkflow, updateWorkflowCard, type ScheduleConfig, type Workflow } from '@/shared/state/workflowsSlice';
import StepList from './StepList';
import { API_BASE, getAuthToken } from '@/shared/config';
import { useAppSelector as _useAppSelector } from '@/shared/hooks';
import ChatInput from '@/app/pages/AgentChat/ChatInput';

interface Props {
  workflow: Workflow;
  steps: Workflow['steps'];
}

function InlineSubtitle({ workflow }: { workflow: Workflow }) {
  const c = useClaudeTokens();
  const modelsByProvider = _useAppSelector((s) => s.models.byProvider);
  const runs = _useAppSelector((s) => s.workflows.runs[workflow.id]);
  const modelLabel = React.useMemo(() => {
    if (!workflow?.model) return '';
    for (const list of Object.values(modelsByProvider || {})) {
      for (const m of (list as Array<{ value: string; label?: string }>) || []) {
        if (m.value === workflow.model) return m.label || workflow.model;
      }
    }
    return workflow.model;
  }, [workflow?.model, modelsByProvider]);
  const duration = React.useMemo(() => {
    if (!runs || runs.length === 0) return '';
    const last = runs.find((r) => r.finished_at);
    if (!last || !last.finished_at) return '';
    const ms = new Date(last.finished_at).getTime() - new Date(last.started_at).getTime();
    if (ms <= 0) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60_000)}m`;
  }, [runs]);
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25, fontSize: '0.82rem', color: c.text.muted, minWidth: 0, overflow: 'hidden' }}>
      {modelLabel && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{modelLabel}</Box>}
      {workflow.mode && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{workflow.mode}</Box>}
      {duration && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{duration}</Box>}
    </Box>
  );
}

export default function SchedulingView({ workflow, steps }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ScheduleConfig | null>(null);

  // The composer behaves like any normal chat: it defaults to the user's
  // configured default model/mode (e.g. their subscription model), not the
  // workflow's stored run model, and its pickers actually work.
  const defaultModel = _useAppSelector((s) => s.settings.data.default_model);
  const defaultMode = _useAppSelector((s) => s.settings.data.default_mode);
  const settingsLoaded = _useAppSelector((s) => s.settings.loaded);
  const [chatModel, setChatModel] = useState(defaultModel || 'sonnet');
  const [chatMode, setChatMode] = useState(defaultMode || 'agent');
  const settingsApplied = useRef(false);
  useEffect(() => {
    if (settingsLoaded && !settingsApplied.current) {
      setChatModel(defaultModel || 'sonnet');
      setChatMode(defaultMode || 'agent');
      settingsApplied.current = true;
    }
  }, [settingsLoaded, defaultModel, defaultMode]);

  const onCancel = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
  }, [dispatch, workflow.id]);

  const onSubmit = useCallback(async (text: string) => {
    const cleaned = (text || '').trim();
    if (!cleaned || busy) return undefined;
    setBusy(true);
    setError(null);
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/parse-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ text: cleaned }),
      });
      if (!res.ok) {
        setError(`Couldn't parse that. Try "every Wednesday at 1pm" or "Mondays at 3pm".`);
        return undefined;
      }
      const data = await res.json();
      const cfg = data?.schedule as ScheduleConfig | undefined;
      if (!cfg) {
        setError(`Couldn't read a schedule out of that. Try being more specific.`);
        return undefined;
      }
      setPending(cfg);
      return cfg;
    } catch (e) {
      setError((e as Error)?.message || 'Network error.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [busy, workflow.id]);

  const onConfirm = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await dispatch(updateWorkflow({
        id: workflow.id,
        patch: { schedule: { ...pending, enabled: true } as Workflow['schedule'] },
        ifMatch: workflow.updated_at || null,
      }));
      dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, [pending, dispatch, workflow.id, workflow.updated_at]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, flex: '1 0 auto' }}>
      {/* Inline header replacement. Image #49: subtitle on LEFT, Cancel
          on RIGHT. Cancel matches the subtitle's weight/size/color so the
          row reads as peers, not a heavy CTA; it just reddens on hover. */}
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <InlineSubtitle workflow={workflow} />
        <Box sx={{ flex: 1 }} />
        <Box
          onClick={onCancel}
          role="button"
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.4,
            fontSize: '0.82rem', fontWeight: 500,
            color: c.text.muted, cursor: 'pointer',
            '&:hover': { color: c.status.error },
          }}>
          <DeleteOutlineRounded sx={{ fontSize: 15 }} />
          Cancel task scheduling
        </Box>
      </Box>
      {/* Steps in a soft bubble so they read as a quoted "here's the workflow"
          block inside the chat, not loose body text. */}
      <Box sx={{ p: 1.5, borderRadius: `${c.radius.lg}px`, bgcolor: c.bg.elevated, border: `1px solid ${c.border.subtle}` }}>
        <StepList steps={steps} />
      </Box>
      {/* Prompt in its own bubble, like an agent message asking for the cadence. */}
      <Box sx={{ p: 1.5, borderRadius: `${c.radius.lg}px`, bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}` }}>
        <Typography sx={{ fontSize: '0.92rem', color: c.text.secondary, lineHeight: 1.45 }}>
          When should this workflow run (e.g. every Wednesday at 1pm)
        </Typography>
      </Box>
      {error && (
        <Typography sx={{ fontSize: '0.82rem', color: c.status.error }}>{error}</Typography>
      )}
      {/* Spacer docks the composer (and the inline confirm) to the bottom of
          the card so it reads like a chat: prompt up top, input below. */}
      <Box sx={{ flex: 1 }} />
      {/* Inline confirm (the HITL "always ask before scheduling" gate). Lives
          in the card right above the composer instead of a screen-dimming
          modal, so it feels native to the chat. */}
      {pending && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap',
          p: 1.25, mb: 1, borderRadius: `${c.radius.lg}px`,
          bgcolor: c.bg.elevated, border: `1px solid ${c.accent.primary}55`,
        }}>
          <Typography sx={{ flex: 1, minWidth: 180, fontSize: '0.86rem', color: c.text.secondary, lineHeight: 1.45 }}>
            Set <b>{workflow.title}</b> to run <b>{describe(pending)}</b>?
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              onClick={() => setPending(null)}
              role="button"
              sx={{ fontSize: '0.84rem', color: c.text.secondary, px: 1, py: 0.5, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>
              Cancel
            </Box>
            <Box
              onClick={onConfirm}
              role="button"
              sx={{
                fontSize: '0.84rem', fontWeight: 700,
                color: '#fff', bgcolor: c.accent.primary,
                px: 1.4, py: 0.5, borderRadius: 999, cursor: 'pointer',
                '&:hover': { filter: 'brightness(1.05)' },
              }}>
              {busy ? 'Applying…' : 'Schedule it'}
            </Box>
          </Box>
        </Box>
      )}
      {/* Real ChatInput (same one the toolbar / agent chat use) so the
          composer matches Image #54 / #64 exactly: live model picker,
          mode picker, thinking level, paperclip + mic, the works. We
          ignore everything except the message text on send and route it
          through /parse-schedule. sessionId is a stable per-workflow id
          so ChatInput's draft persistence survives view re-mounts. */}
      <Box sx={{ mx: -0.5 }}>
        <ChatInput
          onSend={(msg) => { void onSubmit(msg); }}
          mode={chatMode}
          onModeChange={setChatMode}
          model={chatModel}
          onModelChange={setChatModel}
          embedded
          autoFocus
          sessionId={`schedule-${workflow.id}`}
          disabled={busy}
        />
      </Box>
    </Box>
  );
}

function describe(s: ScheduleConfig): string {
  const h12 = ((s.hour + 11) % 12) + 1;
  const ampm = s.hour < 12 ? 'am' : 'pm';
  const time = s.minute === 0 ? `${h12}${ampm}` : `${h12}:${String(s.minute).padStart(2, '0')}${ampm}`;
  if (s.repeat_unit === 'day') return s.repeat_every === 1 ? `every day at ${time}` : `every ${s.repeat_every} days at ${time}`;
  if (s.repeat_unit === 'month') return s.repeat_every === 1 ? `every month at ${time}` : `every ${s.repeat_every} months at ${time}`;
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (s.on_days.length === 5 && [1,2,3,4,5].every((d) => s.on_days.includes(d))) return `weekdays at ${time}`;
  if (s.on_days.length === 2 && [0,6].every((d) => s.on_days.includes(d))) return `weekends at ${time}`;
  if (s.on_days.length === 1) return `${labels[s.on_days[0]]}s at ${time}`;
  return `weekly at ${time}`;
}
