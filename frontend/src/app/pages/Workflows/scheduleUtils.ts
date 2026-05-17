import type { Workflow, ScheduleConfig } from '@/shared/state/workflowsSlice';

export const WEEKDAY_LABEL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const WEEKDAY_LABEL_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const WEEKDAY_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function defaultSchedule(): ScheduleConfig {
  return {
    enabled: false,
    repeat_every: 1,
    repeat_unit: 'week',
    on_days: [],
    hour: 9,
    minute: 0,
    timezone: 'local',
    on_missed: 'skip',
  };
}

export function formatTime(hour: number, minute: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const suffix = hour < 12 ? 'am' : 'pm';
  const mm = String(minute).padStart(2, '0');
  return minute === 0 ? `${h12}${suffix}` : `${h12}:${mm}${suffix}`;
}

// Used in the roomy hub calendar: "10 AM", "12 PM", "1 PM"...
// Matches Figma image #8 styling for the left-column time labels.
export function formatHourLabel(hour: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${h12} ${suffix}`;
}

export function describeSchedule(sched: ScheduleConfig): string {
  if (!sched.enabled) return 'Not scheduled';
  const time = formatTime(sched.hour, sched.minute);
  if (sched.repeat_unit === 'day') {
    return sched.repeat_every === 1 ? `Every day at ${time}` : `Every ${sched.repeat_every} days at ${time}`;
  }
  if (sched.repeat_unit === 'month') {
    return sched.repeat_every === 1 ? `Every month at ${time}` : `Every ${sched.repeat_every} months at ${time}`;
  }
  const days = sched.on_days.length === 0 ? 'week' : sched.on_days
    .slice()
    .sort()
    .map((d) => WEEKDAY_FULL[d])
    .join(', ');
  const cadence = sched.repeat_every === 1 ? `Every ${days}` : `Every ${sched.repeat_every} weeks on ${days}`;
  return `${cadence} at ${time}`;
}

export function describePermissions(workflow: Workflow): string {
  if (!workflow.permissions || workflow.permissions.length === 0) return 'Notify only';
  const labels: string[] = [];
  for (const p of workflow.permissions) {
    if (p.kind === 'notify') labels.push('notify in app');
    else if (p.kind === 'text') labels.push('text');
    else if (p.kind === 'call') labels.push('call');
  }
  return `First ${labels.join(', then ')}`;
}

export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function startOfMonthGrid(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function fireTimesWithin(workflow: Workflow, from: Date, to: Date, cap = 40): Date[] {
  const sched = workflow.schedule;
  if (!sched.enabled) return [];
  const out: Date[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  if (sched.repeat_unit === 'day') {
    const step = Math.max(1, sched.repeat_every);
    for (let i = 0; i < 366 && out.length < cap; i += step) {
      const d = new Date(cursor);
      d.setDate(d.getDate() + i);
      d.setHours(sched.hour, sched.minute, 0, 0);
      if (d >= from && d <= to) out.push(d);
      if (d > to) break;
    }
    return out;
  }

  if (sched.repeat_unit === 'month') {
    let d = new Date(from.getFullYear(), from.getMonth(), Math.min(28, from.getDate()), sched.hour, sched.minute);
    let guard = 0;
    while (d <= to && out.length < cap && guard < 60) {
      if (d >= from) out.push(new Date(d));
      d = new Date(d.getFullYear(), d.getMonth() + Math.max(1, sched.repeat_every), d.getDate(), sched.hour, sched.minute);
      guard += 1;
    }
    return out;
  }

  const allowed = sched.on_days.length ? sched.on_days : [from.getDay()];
  for (let i = 0; i < 60 && out.length < cap; i += 1) {
    const day = new Date(cursor);
    day.setDate(day.getDate() + i);
    if (!allowed.includes(day.getDay())) continue;
    day.setHours(sched.hour, sched.minute, 0, 0);
    if (day >= from && day <= to) out.push(day);
    if (day > to) break;
  }
  return out;
}
