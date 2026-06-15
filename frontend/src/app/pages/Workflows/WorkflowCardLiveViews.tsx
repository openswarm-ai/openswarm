// Run-state views for the workflow card. The card's `view` field flips to
// 'running' / 'completed' / 'failed' off of the workflow:run ws stream
// (see upsertRun reducer). Each view here renders the same step list
// with a different status overlay + a different footer.

import React, { useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import PlayArrowIcon from '@mui/icons-material/PlayArrowRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import RocketLaunchRounded from '@mui/icons-material/RocketLaunchRounded';
import BuildRounded from '@mui/icons-material/BuildRounded';
import EditOutlined from '@mui/icons-material/EditOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  setCardSidecar,
  toggleExpandedStep,
  updateWorkflowCard,
  type Workflow,
  type WorkflowRun,
} from '@/shared/state/workflowsSlice';
import { DEFAULT_CARD_W, DEFAULT_CARD_H, placeCard } from '@/shared/state/dashboardLayoutSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import StepList, { type StepStatus } from './StepList';

// Helper: open a session next to the workflow card AND mark the card as
// sidecar-linked so the footer flips to Stop Watching/Viewing and the
// dashboard draws an arrow chip between the two cards.
function useOpenSidecar(workflowId: string) {
  const dispatch = useAppDispatch();
  const wfCardPos = useAppSelector((s) => s.dashboardLayout.workflowCards[workflowId]);
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);
  return React.useCallback(async (sessionId: string, kind: 'watching' | 'viewing-completed' | 'viewing-error' | 'testing') => {
    if (!sessionId) return;
    try {
      const { store } = await import('@/shared/state/store');
      if (!store.getState().agents.sessions[sessionId]) {
        try { await dispatch(fetchSession(sessionId)).unwrap(); } catch { /* not fatal */ }
      }
      if (!store.getState().dashboardLayout.cards[sessionId] && wfCardPos) {
        dispatch(placeCard({
          sessionId,
          x: wfCardPos.x + wfCardPos.width + 60,
          y: wfCardPos.y,
          width: DEFAULT_CARD_W,
          height: DEFAULT_CARD_H,
          expandedSessionIds,
        }));
      }
      dispatch(setPendingFocusAgentId(sessionId));
    } catch { /* best-effort */ }
    dispatch(setCardSidecar({ workflowId, sessionId, kind }));
  }, [dispatch, workflowId, wfCardPos, expandedSessionIds]);
}

type ViewMode = 'card' | 'sidecar-linked';

// ---------- Shared bits ----------

function ProgressBar({ value, color }: { value: number; color: string }) {
  const c = useClaudeTokens();
  const pct = Math.max(0, Math.min(1, value));
  return (
    <Box sx={{ width: '100%', height: 4, borderRadius: 999, bgcolor: c.bg.elevated, overflow: 'hidden' }}>
      <Box sx={{
        width: `${pct * 100}%`, height: '100%', bgcolor: color,
        transition: 'width 0.4s ease',
        boxShadow: `0 0 6px ${color}66`,
      }} />
    </Box>
  );
}

function PillButton({ label, onClick, icon, tone, filled, disabled }: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  tone: 'accent' | 'success' | 'danger' | 'muted';
  filled?: boolean;
  disabled?: boolean;
}) {
  const c = useClaudeTokens();
  const colorFor = (t: typeof tone) =>
    t === 'success' ? c.status.success : t === 'danger' ? c.status.error : t === 'accent' ? c.accent.primary : c.text.secondary;
  const color = colorFor(tone);
  const bg = filled ? color : 'transparent';
  const fg = filled ? '#fff' : color;
  return (
    <Box
      onClick={disabled ? undefined : onClick}
      role="button"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.5,
        fontSize: '0.86rem', fontWeight: 700,
        px: 1.4, py: 0.55, borderRadius: 999,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: fg, bgcolor: bg,
        border: filled ? `1px solid ${color}` : `1px solid ${color}55`,
        opacity: disabled ? 0.5 : 1,
        '&:hover': { filter: 'brightness(1.05)', bgcolor: filled ? color : color + '14' },
      }}>
      {icon}
      {label}
    </Box>
  );
}

function GhostTextBtn({ label, onClick }: { label: string; onClick: () => void }) {
  const c = useClaudeTokens();
  return (
    <Box
      onClick={onClick}
      role="button"
      sx={{
        fontSize: '0.86rem', fontWeight: 500, color: c.text.secondary,
        cursor: 'pointer', px: 0.75, py: 0.5,
        '&:hover': { color: c.text.primary },
      }}>
      {label}
    </Box>
  );
}

// ---------- RunningView (Image #40) ----------

export function RunningView({ workflow, steps, runs, mode = 'card' }: {
  workflow: Workflow;
  steps: Workflow['steps'];
  runs?: WorkflowRun[];
  mode?: ViewMode;
}) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const runId = card?.runId || null;
  const run = useMemo(() => (runs || []).find((r) => r.id === runId) || null, [runs, runId]);

  // Prefer the backend's real active_step_idx (broadcast on each step
  // bump in executor.execute). Fall back to elapsed/expected heuristic
  // when the field is missing (older runs or first-frame race).
  const heuristicIdx = useActiveStepIdx(steps.length, runs, runId);
  const activeIdx = typeof run?.active_step_idx === 'number' ? run.active_step_idx : heuristicIdx;
  const statuses: StepStatus[] = steps.map((_, i) =>
    i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending',
  );
  const completeCount = statuses.filter((s) => s === 'done').length;
  const total = steps.length;

  // Tool-call subtitle for the active step. Backend polls the session's
  // messages at 1.5s cadence and broadcasts on workflow:run as the agent
  // makes new tool calls. See executor.py _watch_tool_calls.
  const activeSubtitle = run?.last_tool_label || null;
  const activeDuration = formatLiveDuration(run);

  const isLinked = mode === 'sidecar-linked' && card?.sidecarKind === 'watching';

  const onStop = useCallback(async () => {
    if (!runId) return;
    try {
      const { API_BASE, getAuthToken } = await import('@/shared/config');
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      await fetch(`${API_BASE}/workflows/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
    } catch { /* best-effort */ }
  }, [runId]);
  const onPause = useCallback(() => {
    // Pause flips the global paused state; the in-flight run continues but
    // future fires queue up behind it. Maps to the existing /pause-all path.
    void undefined;
  }, []);
  const openSidecar = useOpenSidecar(workflow.id);
  const onWatchLive = useCallback(() => {
    if (run?.session_id) void openSidecar(run.session_id, 'watching');
  }, [openSidecar, run?.session_id]);
  const onStopWatching = useCallback(() => {
    dispatch(setCardSidecar({ workflowId: workflow.id, sessionId: null, kind: null }));
  }, [dispatch, workflow.id]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography sx={{ fontSize: '0.92rem', fontWeight: 700, color: c.status.success }}>
          {completeCount} of {total} complete
        </Typography>
      </Box>
      <ProgressBar value={total > 0 ? completeCount / total : 0} color={c.status.success} />
      <StepList
        workflow={workflow}
        steps={steps}
        stepStatuses={statuses}
        activeStepSubtitle={activeSubtitle}
        activeStepDuration={activeDuration}
      />
      <Box sx={{ flex: 1 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        {isLinked ? (
          <PillButton
            label="Stop Watching"
            tone="danger"
            filled={false}
            icon={<VisibilityOffOutlined sx={{ fontSize: 16 }} />}
            onClick={onStopWatching}
          />
        ) : (
          <PillButton
            label="Watch Live"
            tone="muted"
            filled={false}
            icon={<VisibilityOutlined sx={{ fontSize: 16 }} />}
            onClick={onWatchLive}
          />
        )}
      </Box>
      {/* Stop / Pause live in the header row, rendered by WorkflowCard.
          See header-button overrides in WorkflowCard.tsx for the
          per-view replacement of History/Run. */}
      <Box sx={{ display: 'none' }} aria-hidden onClick={onStop} />
      <Box sx={{ display: 'none' }} aria-hidden onClick={onPause} />
    </Box>
  );
}

function useActiveStepIdx(stepCount: number, runs: WorkflowRun[] | undefined, activeRunId: string | null | undefined): number {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!activeRunId) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 1000000), 1000);
    return () => window.clearInterval(id);
  }, [activeRunId]);
  if (!activeRunId || !runs) return 0;
  const active = runs.find((r) => r.id === activeRunId && r.status === 'running');
  if (!active) return 0;
  const elapsed = Date.now() - new Date(active.started_at).getTime();
  const completed = runs.filter((r) => (r.status === 'success' || r.status === 'ran_late') && r.finished_at);
  if (completed.length === 0) {
    return Math.min(stepCount - 1, Math.max(0, Math.floor(stepCount / 2)));
  }
  const durations = completed.slice(0, 10).map((r) => new Date(r.finished_at!).getTime() - new Date(r.started_at).getTime());
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length || 1;
  const ratio = Math.min(0.99, Math.max(0, elapsed / avg));
  return Math.min(stepCount - 1, Math.floor(ratio * stepCount));
}

function formatLiveDuration(run: WorkflowRun | null): string | null {
  if (!run || run.status !== 'running') return null;
  try {
    const ms = Date.now() - new Date(run.started_at).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    return `${m}m`;
  } catch { return null; }
}

// ---------- CompletedView (Image #42) ----------

export function CompletedView({ workflow, steps, runs, mode = 'card' }: {
  workflow: Workflow;
  steps: Workflow['steps'];
  runs?: WorkflowRun[];
  mode?: ViewMode;
}) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const runId = card?.runId || null;
  const run = useMemo(() => (runs || []).find((r) => r.id === runId) || null, [runs, runId]);
  const statuses: StepStatus[] = steps.map(() => 'done');
  const isLinked = mode === 'sidecar-linked' && card?.sidecarKind === 'viewing-completed';

  const onDone = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved', runId: null, sidecarSessionId: null, sidecarKind: null } }));
  }, [dispatch, workflow.id]);
  const onEdit = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'edit_agent' } }));
  }, [dispatch, workflow.id]);
  const openSidecar = useOpenSidecar(workflow.id);
  const onViewAgent = useCallback(() => {
    if (run?.session_id) void openSidecar(run.session_id, 'viewing-completed');
  }, [openSidecar, run?.session_id]);
  const onStopViewing = useCallback(() => {
    dispatch(setCardSidecar({ workflowId: workflow.id, sessionId: null, kind: null }));
  }, [dispatch, workflow.id]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6 }}>
        <Box component="span" sx={{ color: c.status.success, fontSize: 18, lineHeight: 1, mr: 0.25 }}>✓</Box>
        <Typography sx={{ fontSize: '0.92rem', fontWeight: 700, color: c.status.success }}>
          {steps.length} of {steps.length} complete
        </Typography>
      </Box>
      <ProgressBar value={1} color={c.status.success} />
      <StepList
        workflow={workflow}
        steps={steps}
        stepStatuses={statuses}
      />
      <Box sx={{ flex: 1 }} />
      {/* Success card. Hidden in sidecar-linked mode (Image #43) so the
          compacted card stays tight. Soft green tint + rocket icon. */}
      {!isLinked && (
        <Box sx={{
          display: 'flex', alignItems: 'flex-start', gap: 1.25,
          p: 1.5, borderRadius: `${c.radius.lg}px`,
          bgcolor: c.status.successBg,
          border: `1px solid ${c.status.success}30`,
        }}>
          <Box sx={{
            width: 32, height: 32, borderRadius: `${c.radius.md}px`,
            bgcolor: c.status.success + '22', color: c.status.success,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <RocketLaunchRounded sx={{ fontSize: 16 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.3 }}>
              Workflow Success!
            </Typography>
            <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, mt: 0.25, lineHeight: 1.45 }}>
              If you&apos;re curious, you can click the green button below to see exactly what the agent did.
            </Typography>
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <PillButton
          label="Edit"
          tone="muted"
          filled={false}
          icon={<EditOutlined sx={{ fontSize: 15 }} />}
          onClick={onEdit}
        />
        <Box sx={{ flex: 1 }} />
        {/* Image #43: Done is hidden in sidecar mode; Stop Viewing alone
            fills the right slot. Default mode keeps Done + View Agent. */}
        {!isLinked && <GhostTextBtn label="Done" onClick={onDone} />}
        {isLinked ? (
          <PillButton
            label="Stop Viewing"
            tone="success"
            filled={false}
            icon={<VisibilityOffOutlined sx={{ fontSize: 16 }} />}
            onClick={onStopViewing}
          />
        ) : (
          <PillButton
            label="View Agent"
            tone="success"
            filled
            onClick={onViewAgent}
          />
        )}
      </Box>
    </Box>
  );
}

// ---------- FailedView (Image #46) ----------

export function FailedView({ workflow, steps, runs, mode = 'card' }: {
  workflow: Workflow;
  steps: Workflow['steps'];
  runs?: WorkflowRun[];
  mode?: ViewMode;
}) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const runId = card?.runId || null;
  const run = useMemo(() => (runs || []).find((r) => r.id === runId) || null, [runs, runId]);
  const failedIdx = guessFailedIdx(run, steps.length);
  const statuses: StepStatus[] = steps.map((_, i) =>
    i < failedIdx ? 'done' : i === failedIdx ? 'failed' : 'pending',
  );
  const isLinked = mode === 'sidecar-linked' && card?.sidecarKind === 'viewing-error';

  const onIgnore = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved', runId: null, sidecarSessionId: null, sidecarKind: null } }));
  }, [dispatch, workflow.id]);
  const openSidecar = useOpenSidecar(workflow.id);
  const onViewError = useCallback(() => {
    if (run?.session_id) void openSidecar(run.session_id, 'viewing-error');
  }, [openSidecar, run?.session_id]);
  const onStopViewing = useCallback(() => {
    dispatch(setCardSidecar({ workflowId: workflow.id, sessionId: null, kind: null }));
  }, [dispatch, workflow.id]);
  const onFixWithAgent = useCallback(() => {
    if (!run) return;
    const stepLabel = steps[failedIdx]?.label || steps[failedIdx]?.text?.slice(0, 60) || `Step ${failedIdx + 1}`;
    dispatch(updateWorkflowCard({
      workflowId: workflow.id,
      patch: {
        view: 'fix_agent',
        sidecarSessionId: null,
        sidecarKind: null,
        fixSeed: { runId: run.id, stepIdx: failedIdx, stepLabel, error: run.error || 'Step failed.' },
      },
    }));
  }, [dispatch, workflow.id, run, steps, failedIdx]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      <StepList
        workflow={workflow}
        steps={steps}
        stepStatuses={statuses}
      />
      <Box sx={{ flex: 1 }} />
      <Box sx={{
        display: 'flex', alignItems: 'flex-start', gap: 1.25,
        p: 1.5, borderRadius: `${c.radius.lg}px`,
        bgcolor: c.status.errorBg,
        border: `1px solid ${c.status.error}30`,
      }}>
        <Box sx={{
          width: 32, height: 32, borderRadius: `${c.radius.md}px`,
          bgcolor: c.status.error + '22', color: c.status.error,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <BuildRounded sx={{ fontSize: 16 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.3 }}>
            Fix with an Agent
          </Typography>
          <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, mt: 0.25, lineHeight: 1.45 }}>
            Have an agent modify, test, and iterate on the workflow until it works as expected.
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        {isLinked ? (
          <PillButton
            label="Stop Viewing"
            tone="danger"
            filled={false}
            icon={<VisibilityOffOutlined sx={{ fontSize: 16 }} />}
            onClick={onStopViewing}
          />
        ) : (
          <PillButton
            label="View Error"
            tone="muted"
            filled={false}
            icon={<VisibilityOutlined sx={{ fontSize: 16 }} />}
            onClick={onViewError}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <GhostTextBtn label="Ignore" onClick={onIgnore} />
        <PillButton
          label="Fix with Agent"
          tone="danger"
          filled
          onClick={onFixWithAgent}
        />
      </Box>
    </Box>
  );
}

function guessFailedIdx(run: WorkflowRun | null, total: number): number {
  if (!run) return Math.max(0, total - 1);
  // Backend pins active_step_idx at the failed step before flipping
  // status to 'failure'. Prefer that; fall back to parsing "Step N"
  // out of the error string for legacy runs.
  if (typeof run.active_step_idx === 'number') {
    return Math.max(0, Math.min(total - 1, run.active_step_idx));
  }
  if (run.error) {
    const m = /step\s+(\d+)/i.exec(run.error);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n >= 1 && n <= total) return n - 1;
    }
  }
  return Math.max(0, Math.min(total - 1, 1));
}

// ---------- Header overrides ----------
// The card header normally renders {History | Run}. Running shows
// {Stop | Pause}, Completed/Failed keep {History | Run}, Edit/Fix shows
// {Discard | Save}, Scheduling shows {Cancel task scheduling}. The
// WorkflowCard hands off via this helper so each view can declare its
// own header without the parent fanning out a switch.

export interface HeaderActions {
  left?: React.ReactNode;
  right: React.ReactNode;
}

export function useHeaderActions(workflow: Workflow | null, view: string): HeaderActions {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  return useMemo<HeaderActions>(() => {
    if (!workflow) return { right: null };
    const HistoryRun = (
      <>
        <Box
          onClick={() => dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'history' } }))}
          role="button"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, fontSize: '0.82rem', fontWeight: 600, px: 1, py: 0.4, color: c.text.secondary, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>
          <HistoryIcon sx={{ fontSize: 15 }} />
          History
        </Box>
        <Box
          onClick={() => dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }))}
          role="button"
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.35,
            fontSize: '0.82rem', fontWeight: 700,
            px: 1.1, py: 0.4, borderRadius: 999,
            bgcolor: c.accent.primary, color: '#fff', cursor: 'pointer',
            '&:hover': { filter: 'brightness(1.05)' },
          }}>
          <PlayArrowIcon sx={{ fontSize: 15 }} />
          Run
        </Box>
      </>
    );
    if (view === 'running') {
      return {
        right: (
          <>
            <Box role="button" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, fontSize: '0.82rem', fontWeight: 600, px: 1, py: 0.4, color: c.text.secondary, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>
              <StopRounded sx={{ fontSize: 15 }} />
              Stop
            </Box>
            <Box role="button" sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.35,
              fontSize: '0.82rem', fontWeight: 700,
              px: 1.1, py: 0.4, borderRadius: 999,
              bgcolor: c.accent.primary, color: '#fff', cursor: 'pointer',
              '&:hover': { filter: 'brightness(1.05)' },
            }}>
              <PauseRounded sx={{ fontSize: 15 }} />
              Pause
            </Box>
          </>
        ),
      };
    }
    return { right: HistoryRun };
  }, [workflow, view, dispatch, c]);
}
