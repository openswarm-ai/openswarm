import React, { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import {
  closeWorkflowCard,
  createWorkflow,
  type Workflow,
  type WorkflowRun,
} from '@/shared/state/workflowsSlice';
import { removeWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { describePermissions, describeSchedule } from './scheduleUtils';

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
  if (s === 'ran_late') return 'Ran Late';
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

export function ActionBtn({ label, tone, disabled, onClick }: { label: string; tone: 'muted' | 'success'; disabled?: boolean; onClick: () => void }) {
  const c = useClaudeTokens();
  const isSuccess = tone === 'success';
  return (
    <Box
      onClick={disabled ? undefined : onClick}
      role="button"
      sx={{
        fontSize: '0.85rem', fontWeight: 600, px: 1.25, py: 0.55,
        borderRadius: `${c.radius.md}px`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: isSuccess ? c.status.success : c.text.secondary,
        bgcolor: isSuccess ? c.status.successBg : c.bg.secondary,
        border: `1px solid ${isSuccess ? c.status.success + '60' : c.border.subtle}`,
        opacity: disabled ? 0.5 : 1,
        '&:hover': { bgcolor: isSuccess ? c.status.success + '30' : c.bg.elevated },
      }}>
      {label}
    </Box>
  );
}

export function PreviewView({ workflowId, steps, sourceSessionId, initialDraft, onSaved }: {
  workflowId: string;
  steps: Workflow['steps'];
  sourceSessionId: string | null;
  initialDraft: Partial<Workflow> | null;
  onSaved: (w: Workflow) => void;
}) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [busy, setBusy] = useState(false);
  const title = (initialDraft?.title as string) || 'Email summary request';
  const description = (initialDraft?.description as string) || "This is an ai generated description of the workflow that gets auto generated after you click complete on the last step. It's used when we wrap workflows as tool calls for other agents to invoke";

  const onSave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await dispatch(createWorkflow({
        title,
        description,
        steps: steps.map((s) => ({ id: s.id, text: s.text })),
        source_session_id: sourceSessionId,
        use_synced_prompt: true,
      } as Partial<Workflow>));
      const wf = (result as unknown as { payload: Workflow }).payload;
      if (wf?.id) onSaved(wf);
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, title, description, steps, sourceSessionId, onSaved]);

  const onDiscard = useCallback(() => {
    dispatch(closeWorkflowCard(workflowId));
    dispatch(removeWorkflowCard(workflowId));
  }, [dispatch, workflowId]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Box sx={{ flex: 1, fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.5 }}>{description}</Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0.5 }}>
        {steps.map((s, idx) => (
          <Box key={s.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
            <Box sx={{ width: 24, height: 24, borderRadius: '50%', border: `1px solid ${c.border.medium}`, fontSize: '0.78rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.secondary, flexShrink: 0, mt: 0.25 }}>{idx + 1}</Box>
            <Box sx={{ flex: 1, fontSize: '0.92rem', color: c.text.primary, border: `1px solid ${idx === 0 ? c.border.medium : c.border.subtle}`, borderRadius: `${c.radius.md}px`, px: 1.25, py: 0.75, bgcolor: c.bg.surface, lineHeight: 1.4 }}>{s.text}</Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.75, mt: 1 }}>
        <ActionBtn label="Discard" tone="muted" onClick={onDiscard} />
        <ActionBtn label="Save" tone="success" onClick={onSave} disabled={busy} />
      </Box>
    </Box>
  );
}

export function SavedView({ workflow, steps }: { workflow: Workflow; steps: Workflow['steps'] }) {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary }}><strong style={{ color: c.text.primary }}>Scheduled:</strong> {describeSchedule(workflow.schedule)}</Typography>
      <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary }}><strong style={{ color: c.text.primary }}>Permissions:</strong> {describePermissions(workflow)}</Typography>
      <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.5, mt: 0.5 }}>{workflow.description}</Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0.5 }}>
        {steps.map((s, idx) => (
          <Box key={s.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
            <Box sx={{ width: 24, height: 24, borderRadius: '50%', border: `1px solid ${c.border.medium}`, fontSize: '0.78rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.secondary, flexShrink: 0, mt: 0.25 }}>{idx + 1}</Box>
            <Box sx={{ flex: 1, fontSize: '0.92rem', color: c.text.primary, px: 0.5, lineHeight: 1.45 }}>{s.text}</Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function HistoryList({ runs, onOpen }: { runs: WorkflowRun[]; onOpen: (r: WorkflowRun) => void }) {
  const c = useClaudeTokens();
  if (!runs || runs.length === 0) {
    return <Typography sx={{ fontSize: '0.88rem', color: c.text.muted, py: 1.5, textAlign: 'center' }}>No runs yet</Typography>;
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      {runs.map((r) => (
        <Box
          key={r.id}
          onClick={() => onOpen(r)}
          sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.75, px: 0.5, cursor: 'pointer', borderRadius: 0.75, '&:hover': { bgcolor: c.bg.elevated } }}>
          <Box sx={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor(r.status, c), bgcolor: statusBg(r.status, c), px: 0.8, py: 0.3, borderRadius: 0.75, minWidth: 64, textAlign: 'center' }}>
            {labelForStatus(r.status)}
          </Box>
          <Typography sx={{ fontSize: '0.88rem', color: c.text.primary }}>{formatRunDate(r.started_at)}</Typography>
          <Box sx={{ ml: 'auto', fontSize: '0.78rem', color: c.text.muted }}>Open →</Box>
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
        <Box sx={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor(run.status, c), bgcolor: statusBg(run.status, c), px: 0.8, py: 0.3, borderRadius: 0.75 }}>{labelForStatus(run.status)}</Box>
        <Typography sx={{ fontSize: '0.88rem', color: c.text.primary, fontWeight: 600 }}>{formatRunDate(run.started_at)}</Typography>
      </Box>
      {run.error && (
        <Typography sx={{ fontSize: '0.85rem', color: c.status.error, bgcolor: c.status.errorBg, p: 1, borderRadius: 0.75 }}>{run.error}</Typography>
      )}
      <Typography sx={{ fontSize: '0.85rem', color: c.text.secondary, lineHeight: 1.5 }}>Started {formatRunDate(run.started_at)}, finished {run.finished_at ? formatRunDate(run.finished_at) : 'in progress'}.</Typography>
      {run.session_id && (
        <Box sx={{ fontSize: '0.82rem', color: c.accent.primary, mt: 0.5 }}>Session: {run.session_id.slice(0, 8)}</Box>
      )}
    </Box>
  );
}
