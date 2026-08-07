import { useEffect, useMemo, useState } from 'react';
import { useAppSelector } from '@/shared/hooks';
import { API_BASE } from '@/shared/config';

export interface CalendarOccurrence {
  workflowId: string;
  at: Date;
}

// Single source of truth for "when does a workflow fire": the backend's timezone-aware recurrence engine via /workflows/calendar. The frontend used to recompute this in JS (timezone-naive, missing last-day-of-month), so the calendar disagreed with what actually ran. Fetch the real instants instead. Keeps the current events until a fetch for a NEW window lands so a schedule edit (same window, new fingerprint) refetches without blanking; only a window change clears, since those events are for the wrong span.
export function useCalendarOccurrences(fromIso: string, toIso: string): {
  events: CalendarOccurrence[];
  loaded: boolean;
} {
  const items = useAppSelector((s) => s.workflows.items);
  // Fingerprint only the fields that change which occurrences exist. NOT updated_at: the scheduler bumps it every tick and would churn the fetch.
  const scheduleKey = useMemo(
    () => Object.values(items)
      .map((w) => `${w.id}:${w.schedule.enabled}:${w.schedule.timezone}:${w.schedule.repeat_unit}:${w.schedule.repeat_every}:${w.schedule.hour}:${w.schedule.minute}:${w.schedule.day_of_month ?? ''}:${w.schedule.last_day_of_month ?? ''}:${w.schedule.on_days.join(',')}:${w.schedule.ends_at || ''}:${w.schedule.max_runs ?? ''}:${w.schedule.runs_count}`)
      .sort()
      .join('|'),
    [items],
  );

  // The optimistic pending update flips the fingerprint BEFORE the PATCH commits, so the fingerprint-keyed fetch can read pre-commit truth and then never re-ask (the "toggled the schedule off but Coming up still shows it" bug). settleSeq bumps when the write settles, forcing one authoritative refetch; it also rides the URL so the interceptor's 1s GET cache cannot serve the raced response back.
  const settleSeq = useAppSelector((s) => s.workflows.settleSeq);
  const windowKey = `${fromIso}:${toIso}`;
  const requestKey = `${windowKey}:${scheduleKey}:${settleSeq}`;
  const [events, setEvents] = useState<CalendarOccurrence[]>([]);
  const [fetchedWindowKey, setFetchedWindowKey] = useState('');

  useEffect(() => {
    // No AbortController: the global fetch interceptor dedupes GETs by URL onto one request, so aborting on re-run (as workflows hydrate) would reject the shared request. The `cancelled` guard stops stale state writes instead.
    let cancelled = false;
    fetch(`${API_BASE}/workflows/calendar?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&settle=${settleSeq}`)
      .then((res) => {
        if (!res.ok) throw new Error(`calendar failed ${res.status}`);
        return res.json();
      })
      .then((data: { events?: { workflow_id: string; fire_at: string }[] }) => {
        if (cancelled) return;
        const parsed: CalendarOccurrence[] = [];
        for (const e of data.events || []) {
          const at = new Date(e.fire_at);
          if (!Number.isNaN(at.getTime())) parsed.push({ workflowId: e.workflow_id, at });
        }
        setEvents(parsed);
        setFetchedWindowKey(windowKey);
      })
      .catch(() => {
        if (cancelled) return;
        setFetchedWindowKey(windowKey);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromIso, toIso, requestKey]);

  // Events from a previous window are for the wrong span: hide them until the new window's fetch resolves.
  if (fetchedWindowKey !== windowKey) return { events: [], loaded: false };
  return { events, loaded: true };
}
