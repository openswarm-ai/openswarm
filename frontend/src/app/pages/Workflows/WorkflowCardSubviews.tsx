import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import HistoryIcon from '@mui/icons-material/HistoryToggleOffRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  closeWorkflowCard,
  createWorkflow,
  updateWorkflow,
  type Workflow,
  type WorkflowRun,
} from '@/shared/state/workflowsSlice';
import { removeWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { ScheduleChip, PermissionChip, CostChip, humanDuration, routingFor, StreakBadge } from './workflowVisuals';
import StepList from './StepList';

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
      <StepList steps={steps} framed />
      {/* Save sits on the right; "Throw away" sits on the LEFT separated
          by a flex spacer so a panicked user can't fat-finger the
          destructive option while reaching for Save. */}
      <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
        <ActionBtn label="Throw away" tone="muted" onClick={onDiscard} />
        <Box sx={{ flex: 1 }} />
        <ActionBtn label="Save" tone="success" onClick={onSave} disabled={busy} />
      </Box>
    </Box>
  );
}

export function SavedView({ workflow, steps, runs, activeRunId }: { workflow: Workflow; steps: Workflow['steps']; runs?: WorkflowRun[]; activeRunId?: string | null }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const connectionMode = useAppSelector((s) => (s as { settings?: { data?: { connection_mode?: string } } }).settings?.data?.connection_mode);
  // Habit suggestion: 3+ manual runs in the last 7 days on a workflow
  // that isn't scheduled → quietly offer to schedule it. One click flips
  // the schedule on at the most common time. Auto-disappears once the
  // user enables a schedule.
  const habitSuggestion = useMemo(() => {
    if (workflow.schedule.enabled) return null;
    if (!runs || runs.length < 3) return null;
    const cutoff = Date.now() - 7 * 86400000;
    const recent = runs.filter((r) => r.triggered_by === 'manual' && new Date(r.started_at).getTime() >= cutoff);
    if (recent.length < 3) return null;
    // Pick the most common hour-of-day as the seed.
    const hourCounts: Record<number, number> = {};
    for (const r of recent) {
      const h = new Date(r.started_at).getHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
    const sorted = Object.entries(hourCounts).sort((a, b) => b[1] - a[1]);
    const topHour = Number(sorted[0][0]);
    const formatted = topHour < 12 ? `${topHour === 0 ? 12 : topHour}am` : `${topHour === 12 ? 12 : topHour - 12}pm`;
    return { hour: topHour, label: `daily ${formatted}`, count: recent.length };
  }, [workflow.schedule.enabled, runs]);
  const enableHabit = useCallback(() => {
    if (!habitSuggestion) return;
    dispatch(updateWorkflow({
      id: workflow.id,
      patch: { schedule: { ...workflow.schedule, enabled: true, repeat_unit: 'day', repeat_every: 1, hour: habitSuggestion.hour, minute: 0 } as any },
      ifMatch: workflow.updated_at || null,
    }));
  }, [habitSuggestion, dispatch, workflow.id, workflow.schedule, workflow.updated_at]);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Pill chips replace the two text rows. Same info, glanceable. */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
        <ScheduleChip workflow={workflow} />
        <PermissionChip workflow={workflow} />
        <CostChip workflow={workflow} connectionMode={connectionMode} />
        <StreakBadge runs={runs} />
        <Box sx={{ flex: 1 }} />
        <AuditTraceLink workflowId={workflow.id} />
      </Box>
      {habitSuggestion && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75,
          px: 1, py: 0.5,
          borderRadius: `${c.radius.md}px`,
          bgcolor: c.accent.primary + '14',
          border: `1px solid ${c.accent.primary}40`,
        }}>
          <Typography sx={{ flex: 1, fontSize: '0.78rem', color: c.text.primary }}>
            You&apos;ve run this {habitSuggestion.count}× this week. Schedule it {habitSuggestion.label}?
          </Typography>
          <Box onClick={enableHabit} role="button" sx={{ fontSize: '0.74rem', fontWeight: 700, color: c.accent.primary, cursor: 'pointer', px: 0.5, '&:hover': { textDecoration: 'underline' } }}>
            Yes →
          </Box>
        </Box>
      )}
      <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.5, mt: 0.5 }}>{workflow.description}</Typography>
      <StepList workflow={workflow} steps={steps} runs={runs} activeRunId={activeRunId} />
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
  const close = () => setAnchor(null);
  const count = entries?.length ?? 0;
  return (
    <>
      <Tooltip title="Recent edits to this workflow">
        <Box onClick={open} role="button" sx={{
          display: 'inline-flex', alignItems: 'center', gap: 0.3,
          fontSize: '0.7rem', color: c.text.muted, cursor: 'pointer',
          px: 0.5, py: 0.25, borderRadius: 0.75,
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

export function HistoryList({ runs, onOpen }: { runs: WorkflowRun[]; onOpen: (r: WorkflowRun) => void }) {
  const c = useClaudeTokens();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Filter chips: all / failures / late. Power-users debugging a flaky
  // workflow shouldn't have to scroll past successes.
  const [filter, setFilter] = useState<'all' | 'failure' | 'ran_late'>('all');
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
  // Header sparkline summarising recent successes/failures so users can
  // see "lately broken" before scrolling.
  const recent = (runs || []).slice(0, 30);
  if (!runs || runs.length === 0) {
    return <Typography sx={{ fontSize: '0.88rem', color: c.text.muted, py: 1.5, textAlign: 'center' }}>No runs yet</Typography>;
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75 }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
          {recent.map((r) => (
            <Box key={r.id} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: statusColor(r.status, c) }} />
          ))}
        </Box>
        <Box sx={{ flex: 1 }} />
        {(['all', 'failure', 'ran_late'] as const).map((k) => (
          <Box key={k} onClick={() => setFilter(k)} role="button" sx={{
            fontSize: '0.72rem', fontWeight: 600,
            color: filter === k ? c.accent.primary : c.text.muted,
            bgcolor: filter === k ? c.accent.primary + '14' : 'transparent',
            border: `1px solid ${filter === k ? c.accent.primary + '40' : c.border.subtle}`,
            px: 0.7, py: 0.2, borderRadius: 999, cursor: 'pointer',
            '&:hover': { color: c.accent.primary },
          }}>
            {k === 'all' ? 'All' : k === 'failure' ? 'Failures only' : 'Ran late only'}
          </Box>
        ))}
      </Box>
      {groups.map(({ key, runs: gRuns }) => (
        <Box key={key} sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mt: 0.5, mb: 0.25 }}>
            {key.toUpperCase()}
          </Typography>
          {gRuns.map((r) => {
            const expanded = expandedId === r.id;
            const dur = runDuration(r);
            return (
              <Box key={r.id}>
                <Box
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.6, px: 0.5, cursor: 'pointer', borderRadius: 0.75, '&:hover': { bgcolor: c.bg.elevated } }}>
                  <Box sx={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor(r.status, c), bgcolor: statusBg(r.status, c), px: 0.8, py: 0.3, borderRadius: 0.75, minWidth: 64, textAlign: 'center' }}>
                    {labelForStatus(r.status)}
                  </Box>
                  <Typography sx={{ fontSize: '0.88rem', color: c.text.primary, flex: 1 }}>{formatRunDate(r.started_at)}</Typography>
                  {dur && <Typography sx={{ fontSize: '0.74rem', color: c.text.ghost }}>{dur}</Typography>}
                  {r.cost_usd > 0 && <Typography sx={{ fontSize: '0.74rem', color: c.text.ghost }}>${r.cost_usd.toFixed(4)}</Typography>}
                  {/* Chevron makes the row read as expandable instead of
                      static text. Rotates 180° while open so the affordance
                      stays visible after click. */}
                  <Box sx={{ fontSize: '0.7rem', color: c.text.ghost, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</Box>
                </Box>
                {expanded && (
                  <Box sx={{ ml: 8, mt: 0.25, mb: 0.75, p: 1, bgcolor: c.bg.elevated, borderRadius: 0.75, border: `1px solid ${c.border.subtle}` }}>
                    {r.error ? (
                      <Typography sx={{ fontSize: '0.78rem', color: c.status.error, lineHeight: 1.4 }}>{r.error}</Typography>
                    ) : (
                      <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, lineHeight: 1.4 }}>
                        {r.session_id ? `Saved as session ${r.session_id.slice(0, 8)}.` : 'No session was recorded for this run.'} Click below to see the full conversation.
                      </Typography>
                    )}
                    <Box sx={{ mt: 0.5, display: 'flex', justifyContent: 'flex-end' }}>
                      <Box onClick={(e) => { e.stopPropagation(); onOpen(r); }} role="button" sx={{ fontSize: '0.74rem', fontWeight: 600, color: c.accent.primary, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>
                        See full conversation →
                      </Box>
                    </Box>
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
