import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import HistoryIcon from '@mui/icons-material/HistoryToggleOffRounded';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';
import EditOutlined from '@mui/icons-material/EditOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  closeWorkflowCard,
  createWorkflow,
  toggleExpandedStep,
  updateWorkflow,
  updateWorkflowCard,
  type Workflow,
  type WorkflowRun,
} from '@/shared/state/workflowsSlice';
import { placeCard, removeWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { CostChip, humanDuration, routingFor, StreakBadge } from './workflowVisuals';
import StepList from './StepList';
import { isScheduleConfigured, needsScheduleTestWarning, stepsSignature } from './scheduleUtils';
import ScheduleTestWarningDialog from './ScheduleTestWarningDialog';
import { runWorkflowTest } from './runWorkflowTest';
import { useOpenSidecar } from './WorkflowCardLiveViews';

export function statusColor(s: string, c: ReturnType<typeof useClaudeTokens>): string {
  if (s === 'success') return c.status.success;
  if (s === 'failure') return c.status.error;
  if (s === 'ran_late') return c.status.warning;
  if (s === 'running') return c.accent.primary;
  return c.text.muted;
}

export function statusBg(s: string, c: ReturnType<typeof useClaudeTokens>): string {
  if (s === 'success') return c.status.successBg;
  if (s === 'failure') return c.status.errorBg;
  if (s === 'ran_late') return c.status.warningBg;
  return c.bg.secondary;
}

export function labelForStatus(s: string): string {
  if (s === 'success') return 'Success';
  if (s === 'failure') return 'Failure';
  if (s === 'ran_late') return 'Ran late';
  if (s === 'running') return 'Running';
  if (s === 'skipped') return 'Skipped';
  return s;
}

export function formatRunDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

type ActionBtnTone = 'muted' | 'success' | 'danger';

export function ActionBtn({ label, tone, disabled, onClick, icon }: { label: string; tone: ActionBtnTone; disabled?: boolean; onClick: () => void; icon?: 'trash' | 'check' }) {
  const c = useClaudeTokens();
  // Tone -> color triple. Matches target #58/#63 styling:
  //   success  = green pill (Save)
  //   danger   = red/pink pill (Discard)
  //   muted    = neutral pill (Undo)
  const palette = tone === 'success'
    ? { color: c.status.success, bg: c.status.successBg, border: c.status.success + '60', hover: c.status.success + '30' }
    : tone === 'danger'
      ? { color: c.status.error, bg: c.status.errorBg, border: c.status.error + '60', hover: c.status.error + '30' }
      : { color: c.text.secondary, bg: c.bg.secondary, border: c.border.subtle, hover: c.bg.elevated };
  return (
    <Box
      onClick={disabled ? undefined : onClick}
      role="button"
      sx={{
        // Compact pill matching target #58/#63. Smaller padding + smaller
        // glyphs so the buttons stop overshadowing the step body.
        display: 'inline-flex', alignItems: 'center', gap: 0.4,
        fontSize: '0.78rem', fontWeight: 600,
        px: 1, py: 0.35,
        borderRadius: c.radius.full,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: palette.color,
        bgcolor: palette.bg,
        border: `1px solid ${palette.border}`,
        opacity: disabled ? 0.5 : 1,
        '&:hover': { bgcolor: palette.hover },
      }}>
      {icon === 'trash' && (
        <Box component="span" sx={{ display: 'inline-flex', fontSize: 12, lineHeight: 1 }}>{'\u{1F5D1}'}</Box>
      )}
      {icon === 'check' && (
        <Box component="span" sx={{ display: 'inline-flex', fontSize: 12, lineHeight: 1 }}>{'✓'}</Box>
      )}
      {label}
    </Box>
  );
}

export function PreviewView({ workflowId, steps, sourceSessionId, initialDraft, onSaved, onDiscardDraft, closeRequestNonce }: {
  workflowId: string;
  steps: Workflow['steps'];
  sourceSessionId: string | null;
  initialDraft: Partial<Workflow> | null;
  onSaved: (w: Workflow, options?: { view?: 'saved' | 'scheduling'; close?: boolean }) => void;
  onDiscardDraft?: () => void;
  closeRequestNonce?: number;
}) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [busy, setBusy] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  // Title + description live in the openCard draft so the parent header
  // (which renders the inline-editable title) and PreviewView body (which
  // renders the inline-editable description + steps) stay in sync. On
  // Save we pull whatever's currently in the draft, falling back to the
  // initialDraft passed at mount time.
  const card = useAppSelector((s) => s.workflows.openCards[workflowId]);
  const liveDraft = (card?.draft ?? initialDraft ?? {}) as Partial<Workflow>;
  const title = (liveDraft.title as string) || 'New workflow';
  const description = (liveDraft.description as string) || '';
  const canSave = steps.some((s) => (s.text || '').trim().length > 0);
  // The new workflow runs with the user's configured default model/mode (their
  // subscription, etc.), falling back to whatever the source chat used. Without
  // this the backend picks its own default, which surprised users who'd set a
  // subscription default but saw the workflow created on an API-key model.
  const defaultModel = useAppSelector((s) => s.settings.data.default_model);
  const defaultMode = useAppSelector((s) => s.settings.data.default_mode);
  // Steps render compact (label + chevron, capped + "... N more"), same as
  // the saved card. The raw prompt drills down on click. Keeping them short
  // is what leaves room for the schedule prompt + buttons to stay on-card.
  const expandedIds = card?.expandedStepIds || [];
  const onToggleStep = useCallback((stepId: string) => {
    dispatch(toggleExpandedStep({ workflowId, stepId }));
  }, [dispatch, workflowId]);

  const onDeleteStep = useCallback((idx: number, stepId: string) => {
    if (steps.length <= 1) return;
    const nextSteps = steps.filter((_, i) => i !== idx);
    dispatch(updateWorkflowCard({
      workflowId,
      patch: {
        draft: {
          ...liveDraft,
          steps: nextSteps,
        },
        expandedStepIds: (card?.expandedStepIds || []).filter((id) => id !== stepId),
      },
    }));
  }, [card?.expandedStepIds, dispatch, liveDraft, steps, workflowId]);

  const onChangeDescription = useCallback((value: string) => {
    dispatch(updateWorkflowCard({ workflowId, patch: { draft: { ...liveDraft, description: value } } }));
  }, [dispatch, workflowId, liveDraft]);

  useEffect(() => {
    if (closeRequestNonce) setSavePromptOpen(true);
  }, [closeRequestNonce]);

  const saveWorkflow = useCallback(async (): Promise<Workflow | null> => {
    if (!canSave) return null;
    const result = await dispatch(createWorkflow({
      title,
      description,
      steps: steps.map((s) => ({ id: s.id, text: s.text, label: s.label })),
      metadata_generated: card?.metaGenerated === true,
      source_session_id: sourceSessionId,
      use_synced_prompt: true,
      // The user's configured default wins over whatever model the source chat
      // happened to run on, so a converted workflow behaves like a fresh chat.
      model: defaultModel || (liveDraft.model as string),
      mode: defaultMode || (liveDraft.mode as string),
      // Converting a chat carries its prior approvals, so count it as already
      // validated for these steps: scheduling won't nag to test first.
      tested_signature: sourceSessionId ? stepsSignature(steps) : undefined,
    } as Partial<Workflow>));
    if (!createWorkflow.fulfilled.match(result)) return null;
    const wf = result.payload as Workflow;
    if (wf?.id) return wf;
    return null;
  }, [canSave, dispatch, title, description, steps, sourceSessionId, liveDraft, defaultModel, defaultMode, card]);

  const onIgnore = useCallback(async () => {
    if (busy) return;
    setSavePromptOpen(true);
  }, [busy]);

  const onSaveThenSchedule = useCallback(async () => {
    if (busy || !canSave) return;
    setBusy(true);
    try {
      const wf = await saveWorkflow();
      if (wf?.id) onSaved(wf, { view: 'scheduling' });
    } finally {
      setBusy(false);
    }
  }, [busy, canSave, saveWorkflow, onSaved]);

  const onSaveDraft = useCallback(async () => {
    if (busy || !canSave) return;
    setBusy(true);
    try {
      const wf = await saveWorkflow();
      if (wf?.id) onSaved(wf, { view: 'saved', close: true });
    } finally {
      setBusy(false);
      setSavePromptOpen(false);
    }
  }, [busy, canSave, saveWorkflow, onSaved]);

  const onDontSave = useCallback(() => {
    setSavePromptOpen(false);
    onDiscardDraft?.();
  }, [onDiscardDraft]);

  void onChangeDescription;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      <StepList steps={steps} expandable expandedIds={expandedIds} onToggleExpand={onToggleStep} onDeleteStep={onDeleteStep} />
      <Box sx={{ flex: 1 }} />
      {/* Schedule prompt card. Soft accent tint + calendar icon. Accent is the
          same color the human-intervention (AskUserQuestion) popup uses. */}
      <Box sx={{
        display: 'flex', alignItems: 'flex-start', gap: 1.25,
        p: 1.5, borderRadius: `${c.radius.lg}px`,
        bgcolor: c.accent.primary + '10',
        border: `1px solid ${c.accent.primary}30`,
      }}>
        <Box sx={{
          width: 32, height: 32, borderRadius: `${c.radius.md}px`,
          bgcolor: c.accent.primary + '22', color: c.accent.primary,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <CalendarMonthRounded sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.3 }}>
            Schedule this workflow?
          </Typography>
          <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, mt: 0.25, lineHeight: 1.45 }}>
            You can have workflows run on a recurring basis, automatically.
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1.5 }}>
        <Box
          onClick={onIgnore}
          role="button"
          sx={{
            fontSize: '0.86rem', fontWeight: 500, color: c.text.secondary,
            cursor: busy ? 'wait' : 'pointer', px: 0.75, py: 0.5,
            opacity: busy ? 0.6 : 1,
            '&:hover': { color: c.text.primary },
          }}>
          Not now
        </Box>
        <Box
          onClick={canSave ? onSaveThenSchedule : undefined}
          role="button"
          title={canSave ? undefined : 'Add at least one step before saving'}
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.5,
            fontSize: '0.88rem', fontWeight: 700,
            px: 1.75, py: 0.6, borderRadius: c.radius.full,
            color: '#fff', bgcolor: c.accent.primary,
            cursor: busy ? 'wait' : canSave ? 'pointer' : 'not-allowed',
            opacity: busy || !canSave ? 0.6 : 1,
            '&:hover': { bgcolor: c.accent.primary, filter: 'brightness(1.06)' },
          }}>
          Schedule Workflow
        </Box>
      </Box>
      <Dialog open={savePromptOpen} onClose={() => setSavePromptOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: '1rem', fontWeight: 700 }}>Save workflow?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: '0.86rem', color: c.text.secondary }}>
            Save this workflow under Unscheduled. It will not run until you choose a schedule.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Box
            role="button"
            onClick={onDontSave}
            sx={{ fontSize: '0.84rem', fontWeight: 600, color: c.status.error, cursor: busy ? 'wait' : 'pointer', px: 1, py: 0.5, opacity: busy ? 0.6 : 1 }}>
            Don't Save
          </Box>
          <Box
            role="button"
            onClick={() => setSavePromptOpen(false)}
            sx={{ fontSize: '0.84rem', fontWeight: 600, color: c.text.secondary, cursor: busy ? 'wait' : 'pointer', px: 1, py: 0.5, opacity: busy ? 0.6 : 1 }}>
            Cancel
          </Box>
          <Box
            role="button"
            onClick={canSave ? onSaveDraft : undefined}
            title={canSave ? undefined : 'Add at least one step before saving'}
            sx={{ fontSize: '0.84rem', fontWeight: 700, color: '#fff', bgcolor: c.accent.primary, borderRadius: c.radius.full, cursor: busy ? 'wait' : canSave ? 'pointer' : 'not-allowed', px: 1.5, py: 0.6, opacity: busy || !canSave ? 0.6 : 1, '&:hover': { filter: 'brightness(1.06)' } }}>
            Save
          </Box>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// Render the workflow's permission tiers as a flat prose line so the
// SavedView reads like a sentence, not a chip salad. Mirrors target #54.
function describePermissions(workflow: Workflow): string {
  const tiers = workflow.permissions || [];
  if (tiers.length === 0) return 'Notify me in Open Swarm';
  const parts: string[] = [];
  for (const t of tiers) {
    if (t.kind === 'notify') parts.push('notify in app');
    else if (t.kind === 'text') parts.push('text');
    else if (t.kind === 'call') parts.push('call');
  }
  return `First ${parts.join(', then ')}`;
}

function describeSchedule(workflow: Workflow): string {
  const s = workflow.schedule;
  if (!s.enabled) return 'Not scheduled';
  const h12 = ((s.hour + 11) % 12) + 1;
  const ampm = s.hour < 12 ? 'am' : 'pm';
  const time = s.minute === 0 ? `${h12}${ampm}` : `${h12}:${String(s.minute).padStart(2, '0')}${ampm}`;
  if (s.repeat_unit === 'minute') return `Every ${s.repeat_every} minutes`;
  if (s.repeat_unit === 'hour') return s.repeat_every === 1 ? `Hourly at :${String(s.minute).padStart(2, '0')}` : `Every ${s.repeat_every} hours`;
  if (s.repeat_unit === 'day') return s.repeat_every === 1 ? `Daily at ${time}` : `Every ${s.repeat_every} days at ${time}`;
  if (s.repeat_unit === 'month') {
    const day = s.day_of_month ? ` on day ${s.day_of_month}` : '';
    return s.repeat_every === 1 ? `Monthly${day} at ${time}` : `Every ${s.repeat_every} months${day} at ${time}`;
  }
  if (s.on_days.length === 5 && [1,2,3,4,5].every((d) => s.on_days.includes(d))) return `Weekdays at ${time}`;
  if (s.on_days.length === 2 && [0,6].every((d) => s.on_days.includes(d))) return `Weekends at ${time}`;
  if (s.on_days.length === 1) {
    // Image #50: "Mondays at 3pm" (plural day, no "Every" prefix). Reads
    // more naturally than "Every Mon at 3pm".
    const plurals = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    return `${plurals[s.on_days[0]]} at ${time}`;
  }
  return `Weekly at ${time}`;
}

export function SavedView({ workflow, steps, runs, activeRunId }: { workflow: Workflow; steps: Workflow['steps']; runs?: WorkflowRun[]; activeRunId?: string | null }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  void runs; void activeRunId;
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const expandedIds = card?.expandedStepIds || [];
  const [deletingStepId, setDeletingStepId] = useState<string | null>(null);
  const openEditAgent = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'edit_agent' } }));
  }, [dispatch, workflow.id]);
  const openSidecar = useOpenSidecar(workflow.id);
  const [warnOpen, setWarnOpen] = useState(false);
  const openScheduling = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'scheduling', showScheduleNudge: false } }));
  }, [dispatch, workflow.id]);
  // Gate the schedule action: warn first if the current steps haven't been
  // validated by a test run (so an unattended fire won't silently deny a tool).
  const requestSchedule = useCallback(() => {
    if (needsScheduleTestWarning(workflow)) { setWarnOpen(true); return; }
    openScheduling();
  }, [workflow, openScheduling]);
  const onTestFirst = useCallback(() => {
    setWarnOpen(false);
    void runWorkflowTest(workflow.id, workflow.draft_steps ?? workflow.steps, openSidecar);
  }, [workflow.id, workflow.draft_steps, workflow.steps, openSidecar]);
  const onScheduleAnyway = useCallback(() => {
    setWarnOpen(false);
    openScheduling();
  }, [openScheduling]);
  const onToggleStep = useCallback((stepId: string) => {
    dispatch(toggleExpandedStep({ workflowId: workflow.id, stepId }));
  }, [dispatch, workflow.id]);
  const onDeleteStep = useCallback(async (idx: number, stepId: string) => {
    if (workflow.steps.length <= 1 || deletingStepId) return;
    setDeletingStepId(stepId);
    try {
      await dispatch(updateWorkflow({
        id: workflow.id,
        patch: { steps: workflow.steps.filter((_, i) => i !== idx) },
        ifMatch: workflow.updated_at || null,
      }));
    } finally {
      setDeletingStepId(null);
    }
  }, [deletingStepId, dispatch, workflow.id, workflow.steps, workflow.updated_at]);

  // "Not now" on the post-convert nudge doesn't dump you on a near-identical
  // saved card: the workflow is already saved (find it in the hub), so we drop
  // its card and reopen the chat it came from, right in the same slot.
  const wfCardPos = useAppSelector((s) => s.dashboardLayout.workflowCards[workflow.id]);
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);
  const sourceId = workflow.source_session_id || null;
  const sourceExists = useAppSelector((s) => (sourceId ? !!s.agents.sessions[sourceId] : false));
  const onNotNow = useCallback(() => {
    if (sourceId && sourceExists && wfCardPos) {
      const { x, y, width, height } = wfCardPos;
      dispatch(removeWorkflowCard(workflow.id));
      dispatch(closeWorkflowCard(workflow.id));
      dispatch(placeCard({ sessionId: sourceId, x, y, width, height, expandedSessionIds }));
      dispatch(setPendingFocusAgentId(sourceId));
    } else {
      // No chat to fall back to (rare): just retire the prompt in place.
      dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { showScheduleNudge: false } }));
    }
  }, [dispatch, sourceId, sourceExists, wfCardPos, expandedSessionIds, workflow.id]);

  const scheduleConfigured = isScheduleConfigured(workflow.schedule);
  const scheduleLine = workflow.schedule.enabled && scheduleConfigured ? describeSchedule(workflow) : 'Schedule this workflow';
  const scheduleClickable = !scheduleConfigured;
  // One-shot prompt right after a convert; hub-opened cards never set the flag,
  // so they fall straight to the quiet schedule line below.
  const showNudge = !!card?.showScheduleNudge && !scheduleConfigured;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      <StepList
        workflow={workflow}
        steps={steps}
        expandable
        expandedIds={expandedIds}
        onToggleExpand={onToggleStep}
        onDeleteStep={onDeleteStep}
      />
      <Box sx={{ flex: 1 }} />
      {showNudge && (
        <Box sx={{
          display: 'flex', alignItems: 'flex-start', gap: 1.25,
          p: 1.5, borderRadius: `${c.radius.lg}px`,
          bgcolor: c.accent.primary + '10',
          border: `1px solid ${c.accent.primary}30`,
        }}>
          <Box sx={{
            width: 32, height: 32, borderRadius: `${c.radius.md}px`,
            bgcolor: c.accent.primary + '22', color: c.accent.primary,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CalendarMonthRounded sx={{ fontSize: 18 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.3 }}>
              Schedule this workflow?
            </Typography>
            <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, mt: 0.25, lineHeight: 1.45 }}>
              You can have workflows run on a recurring basis, automatically.
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1.5, mt: 1.25 }}>
              <Box
                onClick={onNotNow}
                role="button"
                sx={{
                  fontSize: '0.86rem', fontWeight: 500, color: c.text.secondary,
                  cursor: 'pointer', px: 0.75, py: 0.5,
                  '&:hover': { color: c.text.primary },
                }}>
                Not now
              </Box>
              <Box
                onClick={requestSchedule}
                role="button"
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.5,
                  fontSize: '0.88rem', fontWeight: 700,
                  px: 1.75, py: 0.6, borderRadius: c.radius.full,
                  color: '#fff', bgcolor: c.accent.primary,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: c.accent.primary, filter: 'brightness(1.06)' },
                }}>
                Schedule Workflow
              </Box>
            </Box>
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        {showNudge ? <Box /> : (
        <Box
          onClick={scheduleClickable ? requestSchedule : undefined}
          role={scheduleClickable ? 'button' : undefined}
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.6,
            color: c.text.secondary, fontSize: '0.86rem', minWidth: 0,
            cursor: scheduleClickable ? 'pointer' : 'default',
            '&:hover': scheduleClickable ? { color: c.text.primary } : {},
          }}>
          <CalendarMonthRounded sx={{ fontSize: 16, color: c.text.muted, flexShrink: 0 }} />
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scheduleLine}</Box>
        </Box>
        )}
        <Box
          onClick={openEditAgent}
          role="button"
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.45,
            fontSize: '0.82rem', fontWeight: 600,
            px: 1.25, py: 0.5,
            borderRadius: c.radius.full,
            cursor: 'pointer',
            color: c.text.secondary,
            bgcolor: 'transparent',
            border: `1px solid ${c.border.medium}`,
            '&:hover': { bgcolor: c.bg.elevated, borderColor: c.border.strong, color: c.text.primary },
          }}>
          <EditOutlined sx={{ fontSize: 15 }} />
          Edit
        </Box>
      </Box>
      <ScheduleTestWarningDialog
        open={warnOpen}
        onClose={() => setWarnOpen(false)}
        onTestFirst={onTestFirst}
        onScheduleAnyway={onScheduleAnyway}
      />
    </Box>
  );
}

// kept on file for legacy uses; once the audit popover migrates, this and
// the StreakBadge / habit-suggestion blocks above can be deleted entirely.
void StreakBadgeRow;

// Splits StreakBadge out so the SavedView body doesn't have to ferry
// the runs array through both the chip row (gone) and the step list.
function StreakBadgeRow({ runs }: { runs?: WorkflowRun[] }) {
  if (!runs || runs.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <StreakBadge runs={runs} />
    </Box>
  );
}

// Audit-trace popover. Lazy-fetches the last N edits from /workflows/{id}/audit
// on open, renders a compact list. The trigger sits inline with the chip
// row so power users can spot it without cluttering the title.
function AuditTraceLink({ workflowId }: { workflowId: string }) {
  const c = useClaudeTokens();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [entries, setEntries] = useState<Array<{ ts: string; who: string; diff: Record<string, { before: unknown; after: unknown }> }> | null>(null);
  const [loading, setLoading] = useState(false);
  // Probe the audit log once on mount so we can hide the trigger entirely
  // when there are no edits (item #21 in target #54 diff). Fire-and-forget;
  // a failure leaves entries=null which renders nothing.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { API_BASE, getAuthToken } = await import('@/shared/config');
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflowId)}/audit?limit=5`, {
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        });
        const data = await res.json();
        if (alive) setEntries(Array.isArray(data?.entries) ? data.entries : []);
      } catch {
        if (alive) setEntries([]);
      }
    })();
    return () => { alive = false; };
  }, [workflowId]);
  // The popover open handler must be declared BEFORE the conditional
  // return below; otherwise React sees a different hook-count between
  // the "loading" render (returns early) and the "loaded with entries"
  // render (calls useCallback), which triggers the "Rendered more hooks
  // than during the previous render" crash.
  const open = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    setAnchor(e.currentTarget);
    if (entries !== null) return;
    setLoading(true);
    try {
      const { API_BASE, getAuthToken } = await import('@/shared/config');
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflowId)}/audit?limit=5`, {
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
      const data = await res.json();
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [entries, workflowId]);
  // Hide entirely until we know whether there are edits to surface.
  if (entries === null || entries.length === 0) return null;
  const close = () => setAnchor(null);
  const count = entries?.length ?? 0;
  return (
    <>
      <Tooltip title="Recent edits to this workflow">
        <Box onClick={open} role="button" sx={{
          display: 'inline-flex', alignItems: 'center', gap: 0.3,
          fontSize: '0.7rem', color: c.text.muted, cursor: 'pointer',
          px: 0.5, py: 0.25, borderRadius: c.radius.sm,
          '&:hover': { color: c.accent.primary, bgcolor: c.bg.elevated },
        }}>
          <HistoryIcon sx={{ fontSize: 12 }} />
          {entries === null ? 'edits' : `${count} edit${count === 1 ? '' : 's'}`}
        </Box>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Box sx={{ minWidth: 280, maxWidth: 360, p: 1 }}>
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mb: 0.5 }}>
            RECENT EDITS
          </Typography>
          {loading && <Typography sx={{ fontSize: '0.78rem', color: c.text.muted }}>Loading…</Typography>}
          {!loading && (entries === null || entries.length === 0) && (
            <Typography sx={{ fontSize: '0.78rem', color: c.text.muted }}>No edits yet.</Typography>
          )}
          {!loading && entries && entries.map((e, idx) => {
            const fields = Object.keys(e.diff || {}).filter((k) => k !== 'updated_at');
            const summary = fields.length === 0 ? 'no field changes' : fields.slice(0, 3).join(', ') + (fields.length > 3 ? `, +${fields.length - 3} more` : '');
            return (
              <Box key={idx} sx={{ display: 'flex', flexDirection: 'column', py: 0.5, borderTop: idx === 0 ? 'none' : `1px solid ${c.border.subtle}` }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography sx={{ fontSize: '0.78rem', color: c.text.primary, fontWeight: 600 }}>{e.who || 'user'}</Typography>
                  <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost }}>{relTimeShort(e.ts)}</Typography>
                </Box>
                <Typography sx={{ fontSize: '0.74rem', color: c.text.secondary }}>{summary}</Typography>
              </Box>
            );
          })}
        </Box>
      </Popover>
    </>
  );
}

function relTimeShort(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return 'just now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch { return ''; }
}

function runDuration(r: WorkflowRun): string | null {
  if (!r.finished_at) return null;
  try {
    const ms = new Date(r.finished_at).getTime() - new Date(r.started_at).getTime();
    if (ms <= 0) return null;
    return humanDuration(ms);
  } catch { return null; }
}

// Groups runs into "This week / Last week / Month YYYY" buckets so a
// long history list reads as eras rather than 50 same-looking dates.
function groupKey(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const day = 24 * 3600 * 1000;
    const startOfWeek = (x: Date) => { const y = new Date(x); y.setHours(0, 0, 0, 0); y.setDate(y.getDate() - y.getDay()); return y; };
    const thisWeekStart = startOfWeek(now).getTime();
    const lastWeekStart = thisWeekStart - 7 * day;
    if (d.getTime() >= thisWeekStart) return 'This week';
    if (d.getTime() >= lastWeekStart) return 'Last week';
    return d.toLocaleString('en', { month: 'long', year: 'numeric' });
  } catch { return 'Earlier'; }
}

export function HistoryList({ runs, onOpen, showWorkflow = false, workflowTitleFor }: { runs: WorkflowRun[]; onOpen: (r: WorkflowRun) => void; showWorkflow?: boolean; workflowTitleFor?: (workflowId: string) => string }) {
  const c = useClaudeTokens();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Filter chips: all / success / failures / skipped. Power-users debugging a
  // flaky workflow shouldn't have to scroll past the runs they don't care about.
  const [filter, setFilter] = useState<'all' | 'success' | 'failure' | 'skipped'>('all');
  const filtered = useMemo(() => {
    if (filter === 'all') return runs;
    return (runs || []).filter((r) => r.status === filter);
  }, [runs, filter]);
  const groups = useMemo(() => {
    const out: Array<{ key: string; runs: WorkflowRun[] }> = [];
    for (const r of filtered || []) {
      const k = groupKey(r.started_at);
      const last = out[out.length - 1];
      if (last && last.key === k) last.runs.push(r);
      else out.push({ key: k, runs: [r] });
    }
    return out;
  }, [filtered]);
  if (!runs || runs.length === 0) {
    return <Typography sx={{ fontSize: '0.88rem', color: c.text.muted, py: 1.5, textAlign: 'center' }}>No runs yet</Typography>;
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75 }}>
        {groups.length > 0 && (
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em' }}>
            {groups[0].key.toUpperCase()}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {(['all', 'success', 'failure', 'skipped'] as const).map((k) => (
          <Box key={k} onClick={() => setFilter(k)} role="button" sx={{
            fontSize: '0.72rem', fontWeight: 600,
            color: filter === k ? c.accent.primary : c.text.muted,
            bgcolor: filter === k ? c.accent.primary + '14' : 'transparent',
            border: `1px solid ${filter === k ? c.accent.primary + '40' : c.border.subtle}`,
            px: 0.75, py: 0.3, borderRadius: c.radius.full, cursor: 'pointer',
            '&:hover': { color: c.accent.primary },
          }}>
            {k === 'all' ? 'All' : k === 'success' ? 'Success' : k === 'failure' ? 'Failures' : 'Skipped'}
          </Box>
        ))}
      </Box>
      {groups.map(({ key, runs: gRuns }, gi) => (
        <Box key={key} sx={{ display: 'flex', flexDirection: 'column' }}>
          {gi > 0 && (
            <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mt: 0.5, mb: 0.25 }}>
              {key.toUpperCase()}
            </Typography>
          )}
          {gRuns.map((r) => {
            const expanded = expandedId === r.id;
            const dur = runDuration(r);
            return (
              <Box key={r.id}>
                <Box
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.6, px: 0.5, cursor: 'pointer', borderRadius: c.radius.sm, '&:hover': { bgcolor: c.bg.elevated } }}>
                  <Box sx={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor(r.status, c), bgcolor: statusBg(r.status, c), px: 0.8, py: 0.3, borderRadius: c.radius.sm, minWidth: 64, textAlign: 'center' }}>
                    {labelForStatus(r.status)}
                  </Box>
                  {showWorkflow && workflowTitleFor ? (
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: '0.84rem', fontWeight: 600, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workflowTitleFor(r.workflow_id)}</Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost }}>{formatRunDate(r.started_at)}</Typography>
                    </Box>
                  ) : (
                    <Typography sx={{ fontSize: '0.88rem', color: c.text.primary, flex: 1 }}>{formatRunDate(r.started_at)}</Typography>
                  )}
                  {dur && <Typography sx={{ fontSize: '0.74rem', color: c.text.ghost }}>{dur}</Typography>}
                  {r.cost_usd > 0 && <Typography sx={{ fontSize: '0.74rem', color: c.text.ghost }}>${r.cost_usd.toFixed(4)}</Typography>}
                  {/* Chevron makes the row read as expandable instead of
                      static text. Rotates 180° while open so the affordance
                      stays visible after click. */}
                  <Box sx={{ fontSize: '0.7rem', color: c.text.ghost, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</Box>
                </Box>
                {expanded && (
                  <Box sx={{ ml: 8, mt: 0.25, mb: 0.75, px: 1, py: 0.75, bgcolor: c.bg.elevated, borderRadius: c.radius.sm, border: `1px solid ${c.border.subtle}`, display: 'flex', alignItems: 'center' }}>

                    {r.error ? (
                      <Typography sx={{ fontSize: '0.78rem', color: c.status.error, lineHeight: 1.4 }}>{r.error}</Typography>
                    ) : r.session_id ? (
                      <Box onClick={(e) => { e.stopPropagation(); onOpen(r); }} role="button" sx={{ fontSize: '0.78rem', fontWeight: 600, color: c.accent.primary, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>
                        Click to see the full conversation →
                      </Box>
                    ) : (
                      <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, lineHeight: 1.4 }}>No session was recorded for this run.</Typography>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export function HistoryDetail({ run, onBack }: { run: WorkflowRun | null; onBack: () => void }) {
  const c = useClaudeTokens();
  if (!run) return <Typography sx={{ fontSize: '0.88rem', color: c.text.muted }}>Run not found</Typography>;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box onClick={onBack} role="button" sx={{ fontSize: '0.82rem', color: c.text.muted, cursor: 'pointer', '&:hover': { color: c.accent.primary } }}>← back</Box>
        <Box sx={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor(run.status, c), bgcolor: statusBg(run.status, c), px: 0.8, py: 0.3, borderRadius: c.radius.sm }}>{labelForStatus(run.status)}</Box>
        <Typography sx={{ fontSize: '0.88rem', color: c.text.primary, fontWeight: 600 }}>{formatRunDate(run.started_at)}</Typography>
      </Box>
      {run.error && (
        <Typography sx={{ fontSize: '0.85rem', color: c.status.error, bgcolor: c.status.errorBg, p: 1, borderRadius: c.radius.sm }}>{run.error}</Typography>
      )}
      <Typography sx={{ fontSize: '0.85rem', color: c.text.secondary, lineHeight: 1.5 }}>Started {formatRunDate(run.started_at)}, finished {run.finished_at ? formatRunDate(run.finished_at) : 'in progress'}.</Typography>
      {run.session_id && (
        <Box sx={{ fontSize: '0.82rem', color: c.accent.primary, mt: 0.5 }}>Session: {run.session_id.slice(0, 8)}</Box>
      )}
    </Box>
  );
}
