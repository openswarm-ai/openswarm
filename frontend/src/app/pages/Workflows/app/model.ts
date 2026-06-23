import type { Workflow, WorkflowRun, ScheduleConfig, ActiveRun } from '@/shared/state/workflowsSlice';
import type { WorkflowsRunContext } from '@/shared/state/dashboardLayoutSlice';
import { isScheduleActive, fireTimesWithin } from '@/app/pages/Workflows/scheduleUtils';

// The design speaks in four cadence buckets; the backend speaks in repeat_unit.
// These two functions are the only place the two vocabularies meet.
export type Freq = 'daily' | 'weekly' | 'monthly' | 'interval';

export function freqOf(sched: ScheduleConfig): Freq {
  switch (sched.repeat_unit) {
    case 'minute':
    case 'hour':
      return 'interval';
    case 'day':
      return 'daily';
    case 'month':
      return 'monthly';
    default:
      return 'weekly';
  }
}

// Build the schedule patch for a cadence-button press, preserving the user's
// existing time/days where the new cadence still uses them.
export function patchForFreq(sched: ScheduleConfig, freq: Freq): Partial<ScheduleConfig> {
  switch (freq) {
    case 'daily':
      return { repeat_unit: 'day', repeat_every: 1 };
    case 'weekly':
      return { repeat_unit: 'week', repeat_every: 1, on_days: sched.on_days.length ? sched.on_days : [1] };
    case 'monthly':
      return { repeat_unit: 'month', repeat_every: 1, day_of_month: sched.day_of_month ?? 1 };
    case 'interval':
      return { repeat_unit: 'minute', repeat_every: Math.max(15, sched.repeat_every || 30) };
    default:
      return {};
  }
}

export function intervalMinutes(sched: ScheduleConfig): number {
  if (sched.repeat_unit === 'hour') return Math.max(1, sched.repeat_every) * 60;
  if (sched.repeat_unit === 'minute') return Math.max(15, sched.repeat_every);
  return 30;
}

export function formatInterval(mins: number): string {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins % 60 === 0) { const h = mins / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function isRunning(wf: Workflow, active: ActiveRun[]): boolean {
  return wf.last_run_status === 'running' || active.some((a) => a.workflow_id === wf.id);
}

export function previewNextRun(wf: Workflow): Date | null {
  if (!isScheduleActive(wf.schedule)) return null;
  const now = new Date();
  const horizon = new Date(now.getTime() + 366 * 86400000);
  const fires = fireTimesWithin(wf, now, horizon, 1);
  return fires[0] ?? null;
}

const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

export function clockOf(date: Date): string {
  return date.toLocaleTimeString([], TIME_OPTS).toLowerCase().replace(' ', '');
}

// "today", "tomorrow", or "Mon Jun 23" — for next-run and coming-up labels.
export function relativeDayLabel(date: Date, now = new Date()): string {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((a.getTime() - b.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function nextRunText(wf: Workflow): string {
  if (!isScheduleActive(wf.schedule)) return '— paused';
  const next = previewNextRun(wf);
  if (!next) return '—';
  return `${relativeDayLabel(next)} at ${clockOf(next)}`;
}

// time <input type=time> value (24h "HH:MM") <-> hour/minute
export function timeInputValue(sched: ScheduleConfig): string {
  return `${String(sched.hour).padStart(2, '0')}:${String(sched.minute).padStart(2, '0')}`;
}

export function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));
  return { hour, minute };
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export interface RunRow {
  id: string;
  status: WorkflowRun['status'];
  summary: string;
  when: Date | null;
  durationText: string;
  cost: number;
}

export function runSummary(run: WorkflowRun, fallbackTitle: string): string {
  if (run.error) return run.error;
  if (run.last_tool_label) return run.last_tool_label;
  if (run.status === 'skipped') return 'Skipped';
  if (run.status === 'running') return 'Running…';
  return fallbackTitle;
}

export function runDuration(run: WorkflowRun): string {
  if (!run.finished_at || !run.started_at) return '';
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function runContextChip(workflow: Workflow, run: WorkflowRun): WorkflowsRunContext {
  const total = workflow.steps.length;
  const aidx = run.active_step_idx ?? 0;
  const dur = runDuration(run);
  const statusWord = run.status === 'success' ? 'completed'
    : run.status === 'ran_late' ? 'completed late'
    : run.status === 'failure' ? 'failed'
    : run.status === 'running' ? 'running'
    : run.status === 'skipped' ? 'skipped' : run.status;
  const stepsPart = run.status === 'failure' ? `failed at step ${Math.min(aidx + 1, total)}`
    : (run.status === 'success' || run.status === 'ran_late') ? `${total}/${total} steps`
    : total > 0 ? `${Math.min(aidx, total)}/${total} steps` : '';
  const title = run.triggered_by === 'manual' ? 'Manual run'
    : run.triggered_by === 'retry' ? 'Re-run' : 'Scheduled run';
  const color = run.status === 'failure' ? '#C2483A'
    : (run.status === 'success' || run.status === 'ran_late') ? '#3F8E5B' : '#C25A36';
  return {
    workflowId: workflow.id,
    runId: run.id,
    title,
    metaLabel: [statusWord, dur, stepsPart].filter(Boolean).join(' · '),
    color,
  };
}

export function toRunRow(run: WorkflowRun, title: string): RunRow {
  return {
    id: run.id,
    status: run.status,
    summary: runSummary(run, title),
    when: run.started_at ? new Date(run.started_at) : (run.scheduled_for ? new Date(run.scheduled_for) : null),
    durationText: runDuration(run),
    cost: run.cost_usd,
  };
}

export function whenText(date: Date | null, now = new Date()): string {
  if (!date) return '';
  const rel = relativeDayLabel(date, now);
  const cap = rel.charAt(0).toUpperCase() + rel.slice(1);
  return `${cap}, ${clockOf(date)}`;
}
