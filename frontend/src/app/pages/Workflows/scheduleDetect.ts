// Lightweight text-to-schedule detector. Runs on agent replies (and user
// prompts) to surface a "Schedule this?" chip when the conversation has
// time-shaped language. Cheap regex pass, no LLM call. Returns the best
// matching preset or null. Conservative on purpose: a false positive
// shows a quietly-dismissable chip; a false negative just means the user
// uses the regular Schedule button.

import type { ScheduleConfig } from '@/shared/state/workflowsSlice';
import { defaultSchedule } from './scheduleUtils';

export interface DetectedSchedule {
  schedule: ScheduleConfig;
  presetLabel: string;
}

const HOUR_WORDS: Record<string, number> = {
  morning: 9, noon: 12, afternoon: 14, evening: 18, night: 21, midnight: 0,
};

// Match "9am" / "9 a.m." / "10:30 PM" / "at 7" (defaults am).
const HOUR_RE = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i;

const DAY_RE = /\b(sun|mon|tue|wed|thu|fri|sat)(?:day)?s?\b/gi;
const DAY_MAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function detectSchedule(text: string): DetectedSchedule | null {
  if (!text) return null;
  const t = text.toLowerCase();
  // Require either an explicit frequency keyword or a clear weekday +
  // time pattern. Avoids false positives on stray "tomorrow at 9."
  const isDaily = /\b(every ?day|each day|daily)\b/.test(t);
  const isWeekdays = /\b(weekdays?|each weekday|every weekday|mon(?:day)?\s*(?:to|-|through|–)\s*fri(?:day)?)\b/.test(t);
  const isWeekly = /\b(every week|weekly|each week|once a week)\b/.test(t);
  const isMonthly = /\b(every month|monthly|each month|once a month)\b/.test(t);
  const dayMatches = Array.from(t.matchAll(DAY_RE)).map((m) => DAY_MAP[m[1].toLowerCase().slice(0, 3)]);
  const hasExplicitDays = dayMatches.length > 0;
  if (!isDaily && !isWeekdays && !isWeekly && !isMonthly && !hasExplicitDays) return null;

  // Extract hour:minute.
  let hour = 9;
  let minute = 0;
  let presetTimeWord: string | null = null;
  for (const word of Object.keys(HOUR_WORDS)) {
    if (t.includes(word)) { hour = HOUR_WORDS[word]; presetTimeWord = word; break; }
  }
  const hm = t.match(HOUR_RE);
  if (hm) {
    const raw = parseInt(hm[1], 10);
    const m = hm[2] ? parseInt(hm[2], 10) : 0;
    const ampm = (hm[3] || '').toLowerCase();
    let h = raw;
    if (ampm.startsWith('p') && h < 12) h += 12;
    if (ampm.startsWith('a') && h === 12) h = 0;
    // Only accept the regex hit if it's a plausible hour AND we didn't
    // already get a confident word-based hour. Words win because "every
    // morning at 9" should be 9am, not the literal "9" with no ampm
    // bumped into pm.
    if (h >= 0 && h < 24) {
      if (!presetTimeWord) { hour = h; minute = m; }
    }
  }

  const base = defaultSchedule();
  if (isMonthly) {
    return {
      schedule: { ...base, enabled: true, repeat_unit: 'month', repeat_every: 1, hour, minute },
      presetLabel: `Every month at ${formatHour(hour, minute)}`,
    };
  }
  if (isWeekdays) {
    return {
      schedule: { ...base, enabled: true, repeat_unit: 'week', repeat_every: 1, on_days: [1, 2, 3, 4, 5], hour, minute },
      presetLabel: `Weekdays at ${formatHour(hour, minute)}`,
    };
  }
  if (isDaily) {
    return {
      schedule: { ...base, enabled: true, repeat_unit: 'day', repeat_every: 1, hour, minute },
      presetLabel: `Every day at ${formatHour(hour, minute)}`,
    };
  }
  if (hasExplicitDays || isWeekly) {
    const days = Array.from(new Set(dayMatches.length ? dayMatches : [new Date().getDay()]));
    days.sort();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const label = days.length === 1 ? `Every ${dayNames[days[0]]} at ${formatHour(hour, minute)}` : `${days.map((d) => dayNames[d]).join('/')} at ${formatHour(hour, minute)}`;
    return {
      schedule: { ...base, enabled: true, repeat_unit: 'week', repeat_every: 1, on_days: days, hour, minute },
      presetLabel: label,
    };
  }
  return null;
}

function formatHour(h: number, m: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}
