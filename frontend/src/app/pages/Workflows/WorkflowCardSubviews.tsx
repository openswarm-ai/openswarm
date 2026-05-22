import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import HistoryIcon from '@mui/icons-material/HistoryToggleOffRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  closeWorkflowCard,
  createWorkflow,
  updateWorkflow,
  updateWorkflowCard,
  type Workflow,
  type WorkflowRun,
} from '@/shared/state/workflowsSlice';
import { removeWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { CostChip, humanDuration, routingFor, StreakBadge } from './workflowVisuals';
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
        borderRadius: 999,
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
  // Title + description live in the openCard draft so the parent header
  // (which renders the inline-editable title) and PreviewView body (which
  // renders the inline-editable description + steps) stay in sync. On
  // Save we pull whatever's currently in the draft, falling back to the
  // initialDraft passed at mount time.
  const card = useAppSelector((s) => s.workflows.openCards[workflowId]);
  const liveDraft = (card?.draft ?? initialDraft ?? {}) as Partial<Workflow>;
  const title = (liveDraft.title as string) || 'New workflow';
  const description = (liveDraft.description as string) || '';
  // Track step text edits locally so the textarea stays uncontrolled-ish
  // (no remote round-trip on every keystroke). On Save we pass the
  // edited values through.
  const [editedSteps, setEditedSteps] = useState<Workflow['steps'] | null>(null);
  const liveSteps = editedSteps || steps;

  const onSave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await dispatch(createWorkflow({
        title,
        description,
        steps: liveSteps.map((s) => ({ id: s.id, text: s.text })),
        source_session_id: sourceSessionId,
        use_synced_prompt: true,
      } as Partial<Workflow>));
      const wf = (result as unknown as { payload: Workflow }).payload;
      if (wf?.id) onSaved(wf);
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, title, description, liveSteps, sourceSessionId, onSaved]);

  const onDiscard = useCallback(() => {
    dispatch(closeWorkflowCard(workflowId));
    dispatch(removeWorkflowCard(workflowId));
  }, [dispatch, workflowId]);

  const onChangeDescription = useCallback((value: string) => {
    dispatch(updateWorkflowCard({ workflowId, patch: { draft: { ...liveDraft, description: value } } }));
  }, [dispatch, workflowId, liveDraft]);

  const onChangeStep = useCallback((idx: number, value: string) => {
    const next = (liveSteps || []).slice();
    if (!next[idx]) return;
    next[idx] = { ...next[idx], text: value };
    setEditedSteps(next);
  }, [liveSteps]);

  return (
    // PreviewView visually matches SavedView (target image #107): same
    // Scheduled / Permissions prose, same framed step boxes. Title +
    // description come from the AI gen at save time; the user doesn't
    // type a description here. Discard/Save sits in the bottom-right.
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.35 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: c.text.primary }}>Scheduled:</Typography>
          <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary }}>Not scheduled</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: c.text.primary }}>Permissions:</Typography>
          <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary }}>Notify me in Open Swarm</Typography>
        </Box>
      </Box>
      {description && (
        <Typography sx={{ fontSize: '0.92rem', color: c.text.secondary, lineHeight: 1.55, mt: 0.5 }}>
          {description}
        </Typography>
      )}
      <StepList steps={liveSteps} framed onChangeStep={onChangeStep} />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1, mt: 'auto' }}>
        <ActionBtn label="Discard" tone="danger" icon="trash" onClick={onDiscard} />
        <ActionBtn label="Save" tone="success" icon="check" onClick={onSave} disabled={busy} />
      </Box>
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
  if (s.repeat_unit === 'day') return s.repeat_every === 1 ? `Every day at ${time}` : `Every ${s.repeat_every} days at ${time}`;
  if (s.repeat_unit === 'month') return s.repeat_every === 1 ? `Every month at ${time}` : `Every ${s.repeat_every} months at ${time}`;
  if (s.on_days.length === 5 && [1,2,3,4,5].every((d) => s.on_days.includes(d))) return `Weekdays at ${time}`;
  if (s.on_days.length === 2 && [0,6].every((d) => s.on_days.includes(d))) return `Weekends at ${time}`;
  if (s.on_days.length === 1) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `Every ${labels[s.on_days[0]]} at ${time}`;
  }
  return `Weekly at ${time}`;
}

export function SavedView({ workflow, steps, runs, activeRunId }: { workflow: Workflow; steps: Workflow['steps']; runs?: WorkflowRun[]; activeRunId?: string | null }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const connectionMode = useAppSelector((s) => (s as { settings?: { data?: { connection_mode?: string } } }).settings?.data?.connection_mode);
  void c; void connectionMode;

  // All steps editable inline. Each keystroke updates a local override
  // map; Discard/Save surface as soon as any step diverges from the
  // saved value. On Save we PATCH the full steps array, preserving ids.
  const [localSteps, setLocalSteps] = useState<Record<number, string>>({});
  const [savingFirst, setSavingFirst] = useState(false);
  const firstStepDirty = useMemo(() => {
    for (const k of Object.keys(localSteps)) {
      const idx = Number(k);
      const saved = steps[idx]?.text ?? '';
      if (localSteps[idx] !== saved) return true;
    }
    return false;
  }, [localSteps, steps]);
  const editableSteps = useMemo(() => {
    if (!firstStepDirty) return steps;
    return steps.map((s, idx) => (idx in localSteps ? { ...s, text: localSteps[idx] } : s));
  }, [firstStepDirty, steps, localSteps]);
  const onChangeFirstStep = useCallback((idx: number, text: string) => {
    setLocalSteps((prev) => ({ ...prev, [idx]: text }));
  }, []);
  const onSaveFirstStep = useCallback(async () => {
    if (!firstStepDirty || savingFirst) return;
    setSavingFirst(true);
    try {
      const nextSteps = steps.map((s, idx) => (idx in localSteps ? { ...s, text: localSteps[idx] } : s));
      await dispatch(updateWorkflow({
        id: workflow.id,
        patch: { steps: nextSteps },
        ifMatch: workflow.updated_at || null,
      }));
      setLocalSteps({});
    } finally {
      setSavingFirst(false);
    }
  }, [firstStepDirty, savingFirst, steps, localSteps, dispatch, workflow.id, workflow.updated_at]);
  const onDiscardFirstStep = useCallback(() => setLocalSteps({}), []);
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
  // Audit trigger lazy-loads the edit log; only show it when the
  // workflow has actually been edited. Skips the noisy "0 edits" link
  // on freshly created cards. We trigger the fetch on mount once so the
  // "edits"/no-edits decision is honest by the time the user reads.
  // minHeight: 100% lets the bottom-right cluster pin to the bottom of
  // the card body via mt:auto below.
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      {/* Prose lines per target #54: "Scheduled:" + "Permissions:".
          Reads like a sentence the user can skim instead of a pill row
          that needs hovering to decode. Cost stays as a small inline
          chip on the right when there's anything to say. */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.35 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: c.text.primary }}>Scheduled:</Typography>
          <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary }}>{describeSchedule(workflow)}</Typography>
          <Box sx={{ flex: 1 }} />
          {workflow.cost_estimate && workflow.cost_estimate.fires_per_month > 0 && (
            <CostChip workflow={workflow} connectionMode={connectionMode} />
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: c.text.primary }}>Permissions:</Typography>
          <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary }}>{describePermissions(workflow)}</Typography>
        </Box>
      </Box>
      <StreakBadgeRow runs={runs} />
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
            Yes
          </Box>
        </Box>
      )}
      {workflow.description && (
        <Typography sx={{ fontSize: '0.92rem', color: c.text.secondary, lineHeight: 1.55, mt: 0.5 }}>
          {workflow.description}
        </Typography>
      )}
      <StepList
        workflow={workflow}
        steps={editableSteps}
        runs={runs}
        activeRunId={activeRunId}
        framed
        onChangeStep={onChangeFirstStep}
      />
      {/* Bottom-right cluster matching target image #63. Discard + Save
          only surface when the user has actually edited the first step
          inline; otherwise we don't crowd the card with idle buttons. */}
      {firstStepDirty ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1, mt: 'auto' }}>
          <ActionBtn label="Discard" tone="danger" icon="trash" onClick={onDiscardFirstStep} />
          <ActionBtn label={savingFirst ? 'Saving…' : 'Save'} tone="success" icon="check" disabled={savingFirst} onClick={onSaveFirstStep} />
        </Box>
      ) : (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 'auto' }}>
          <AuditTraceLink workflowId={workflow.id} />
        </Box>
      )}
    </Box>
  );
}

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
