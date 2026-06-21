import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Popover from '@mui/material/Popover';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { API_BASE } from '@/shared/config';
import type { Workflow } from '@/shared/state/workflowsSlice';
import { runWorkflowNow, deleteWorkflow, updateWorkflow, openWorkflowCard } from '@/shared/state/workflowsSlice';
import { addWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { WEEKDAY_FULL, WEEKDAY_LABEL_SHORT, addDays, sameDay, startOfMonthGrid, startOfWeek, formatTime, formatHourLabel, stepsSignature } from './scheduleUtils';
import { useWindowedList } from '@/shared/hooks/useWindowedList';

interface Props {
  view: 'Week' | 'Month' | 'List';
  density: 'compact' | 'roomy';
  onSelectWorkflow?: (id: string, fireAt?: Date) => void;
  refDate?: Date;
}

// Both compact (popover) and roomy (hub) show the full 24 hours scrollable —
// the user explicitly wants midnight visible at the top, not "9am" as the
// starting hour. The scroll container caps the visible window.
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

// At/above this many list rows (day headers + event rows), window the list so
// only near-viewport rows stay mounted. Below it, render whole; spacers aren't
// worth the churn on a short list.
const LIST_WINDOW_MIN_ROWS = 60;

interface CalendarEvent {
  workflow_id: string;
  fire_at: string;
}

// One flattened list row. Windowing unmounts at this granularity, so a dense
// single day no longer mounts all ~96 of its rows just for being near the
// viewport: only the rows actually in view (plus buffer) stay in the DOM.
type ListRow =
  | { kind: 'header'; id: string; date: Date; isToday: boolean }
  | { kind: 'event'; id: string; ev: { workflow: Workflow; date: Date } }
  | { kind: 'empty'; id: string };

export default function ScheduleCalendar({ view, density, onSelectWorkflow, refDate }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const workflows = useAppSelector((s) => Object.values(s.workflows.items));
  const allPaused = useAppSelector((s) => s.workflows.paused);
  // Live clock for the "now" line; a snapshot would drift and refDate may be
  // a navigated week, so it can't double as the current moment.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Right-click menu: pinned position + the workflow whose pill was
  // clicked. Same anchor pattern as MUI's menu examples.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; workflow: Workflow } | null>(null);
  const closeMenu = () => setCtxMenu(null);
  const onRunNow = () => {
    if (!ctxMenu) return;
    dispatch(runWorkflowNow({
      id: ctxMenu.workflow.id,
      signature: stepsSignature(ctxMenu.workflow.steps),
    }));
    closeMenu();
  };
  const onPauseToggle = () => {
    if (!ctxMenu) return;
    const wf = ctxMenu.workflow;
    dispatch(updateWorkflow({
      id: wf.id,
      patch: { schedule: { ...wf.schedule, enabled: !wf.schedule.enabled } as any },
      ifMatch: wf.updated_at || null,
    }));
    closeMenu();
  };
  const onEdit = () => {
    if (!ctxMenu) return;
    dispatch(addWorkflowCard({ workflowId: ctxMenu.workflow.id }));
    // Right-click "Edit" on a calendar entry opens the new Edit Agent
    // chat view, matching the post-revamp design (Image #38).
    dispatch(openWorkflowCard({ workflowId: ctxMenu.workflow.id, view: 'edit_agent' }));
    closeMenu();
  };
  const onDelete = () => {
    if (!ctxMenu) return;
    const ok = window.confirm(`Delete "${ctxMenu.workflow.title}"? Scheduled runs will stop.`);
    if (!ok) { closeMenu(); return; }
    dispatch(deleteWorkflow(ctxMenu.workflow.id));
    closeMenu();
  };
  const ctxMenuEl = (
    <Menu
      open={Boolean(ctxMenu)}
      onClose={closeMenu}
      anchorReference="anchorPosition"
      anchorPosition={ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined}>
      <MenuItem onClick={onRunNow}>Run now</MenuItem>
      <MenuItem onClick={onPauseToggle}>{ctxMenu?.workflow.schedule.enabled ? 'Pause schedule' : 'Resume schedule'}</MenuItem>
      <MenuItem onClick={onEdit}>Edit…</MenuItem>
      <MenuItem onClick={onDelete} sx={{ color: c.status.error }}>Delete</MenuItem>
    </Menu>
  );
  // refDate is recreated on every render unless the caller memoizes it.
  // Pin the calendar to a day-precision key so occurrence fetches only
  // change when the visible day, view, or schedule set changes.
  const today = refDate || new Date();
  const dayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const compact = density === 'compact';
  const range = view === 'Month' ? 35 : view === 'Week' ? 7 : 14;
  const rangeStart = useMemo(
    () => view === 'Month' ? startOfMonthGrid(today) : view === 'Week' ? startOfWeek(today) : new Date(today.getFullYear(), today.getMonth(), today.getDate()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, dayKey],
  );
  const rangeEndExclusive = useMemo(() => addDays(rangeStart, range), [rangeStart, range]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarFetchKey, setCalendarFetchKey] = useState('');
  // Key off only the fields that change which occurrences exist. Deliberately
  // NOT updated_at: the scheduler bumps it every tick (recomputing next_run_at)
  // and pushes a workflow:updated over the socket, which would churn this key
  // and blank the calendar (the eventsByDay gate) until the next fetch lands.
  const workflowScheduleKey = workflows
    .map((w) => `${w.id}:${w.schedule.enabled}:${w.schedule.timezone}:${w.schedule.repeat_unit}:${w.schedule.repeat_every}:${w.schedule.hour}:${w.schedule.minute}:${w.schedule.day_of_month ?? ''}:${w.schedule.on_days.join(',')}:${w.schedule.ends_at || ''}:${w.schedule.max_runs ?? ''}:${w.schedule.runs_count}`)
    .sort()
    .join('|');
  const fromIso = rangeStart.toISOString();
  const toIso = rangeEndExclusive.toISOString();
  const calendarRequestKey = `${view}:${fromIso}:${toIso}:${workflowScheduleKey}`;
  // The visible window alone decides whether shown events are even plausible.
  // Gating on this (not the full request key) means a schedule edit refetches
  // without blanking the calendar first: we keep the current events until the
  // fresh ones land. Only a view/date change, where old events are for the
  // wrong window, clears them.
  const calendarWindowKey = `${view}:${fromIso}:${toIso}`;

  useEffect(() => {
    // No AbortController: the global fetch interceptor (shared/config) dedupes
    // GETs by URL onto ONE underlying request, so aborting on cleanup (which
    // fires when this effect re-runs as workflows hydrate) rejects the shared
    // request and the re-fired fetch with it, leaving the calendar empty on
    // first load. The `cancelled` guard already stops stale state writes.
    let cancelled = false;
    fetch(`${API_BASE}/workflows/calendar?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`calendar failed ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setCalendarEvents((data.events || []) as CalendarEvent[]);
        setCalendarFetchKey(calendarWindowKey);
      })
      .catch(() => {
        if (cancelled) return;
        setCalendarFetchKey(calendarWindowKey);
      });
    return () => {
      cancelled = true;
    };
  }, [fromIso, toIso, calendarRequestKey]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, { workflow: Workflow; date: Date }[]>();
    if (calendarFetchKey !== calendarWindowKey) {
      return { map, start: rangeStart, end: rangeEndExclusive, key: calendarFetchKey };
    }
    const workflowById = new Map(workflows.map((wf) => [wf.id, wf]));
    for (const event of calendarEvents) {
      const wf = workflowById.get(event.workflow_id);
      if (!wf) continue;
      const d = new Date(event.fire_at);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = map.get(key) || [];
      arr.push({ workflow: wf, date: d });
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    return { map, start: rangeStart, end: rangeEndExclusive, key: calendarFetchKey };
  }, [calendarEvents, calendarFetchKey, calendarWindowKey, workflows, rangeStart, rangeEndExclusive]);

  // List view can fan out to ~1300 rows for a dense schedule (every 15 min over
  // 14 days). Flatten days into rows and window at the row level so off-screen
  // rows unmount instead of weighing the whole app down. Computed up here (not
  // in the List branch) so the windowing hook runs before the Week/Month early
  // returns.
  const upcoming = useMemo(() => {
    const out: { date: Date; events: { workflow: Workflow; date: Date }[]; isToday: boolean }[] = [];
    for (let i = 0; i < 14; i += 1) {
      const day = addDays(today, i);
      const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
      const arr = eventsByDay.map.get(key) || [];
      const isToday = sameDay(day, today);
      if (arr.length || isToday) out.push({ date: day, events: arr, isToday });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsByDay, dayKey]);
  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    for (const day of upcoming) {
      const iso = day.date.toISOString();
      out.push({ kind: 'header', id: `h:${iso}`, date: day.date, isToday: day.isToday });
      if (day.events.length === 0) {
        out.push({ kind: 'empty', id: `x:${iso}` });
      } else {
        for (const ev of day.events) {
          out.push({ kind: 'event', id: `${iso}#${ev.workflow.id}#${ev.date.getTime()}`, ev });
        }
      }
    }
    return out;
  }, [upcoming]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const estimateRowHeight = useCallback((index: number) => {
    const r = rows[index];
    if (!r) return 41;
    return r.kind === 'header' ? 52 : r.kind === 'empty' ? 36 : 41;
  }, [rows]);
  const windowing = useWindowedList({
    ids: rowIds,
    estimateHeight: estimateRowHeight,
    enabled: view === 'List' && rows.length >= LIST_WINDOW_MIN_ROWS,
  });

  const SLOT_H = compact ? 40 : 60;
  const ROW_LABEL = compact ? '0.7rem' : '0.74rem';
  const DAY_NUM = compact ? '0.95rem' : '1.15rem';
  const DAY_LABEL = compact ? '0.66rem' : '0.72rem';
  const EVENT_FS = compact ? '0.56rem' : '0.58rem';

  if (view === 'Week') {
    const start = startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const HOURS = HOURS_24;
    const nowColIdx = days.findIndex((d) => sameDay(d, now));
    const nowTopPx = (now.getHours() + now.getMinutes() / 60) * SLOT_H;
    // Prefer the short zone name ("PDT", "EST", "JST") so the label
    // reads in plain English instead of "GMT-7". formatToParts is wide-
    // supported; if it ever fails we degrade silently rather than show
    // a confusing fallback.
    const TZ_LABEL = (() => {
      try {
        const parts = new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(new Date());
        return parts.find((p) => p.type === 'timeZoneName')?.value || '';
      } catch { return ''; }
    })();
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', color: c.text.secondary }}>
        {/* Day headers: muted weekday caps; today's date gets the filled circle */}
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: '64px repeat(7, 1fr)',
          gap: 0,
          position: 'sticky',
          top: 0,
          bgcolor: c.bg.surface,
          zIndex: 20,
          borderBottom: `1px solid ${c.border.subtle}`,
          pt: 1.25,
          pb: 0.5,
          overflow: 'hidden',
          isolation: 'isolate',
          '&::before': {
            content: '""',
            position: 'absolute',
            inset: '-1px',
            bgcolor: c.bg.surface,
            zIndex: 0,
          },
          '& > *': { position: 'relative', zIndex: 1 },
        }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', pr: 1, pb: 0.5 }}>
            {!compact && (
              <Typography sx={{ fontSize: '0.62rem', color: c.text.ghost, fontWeight: 500 }}>{TZ_LABEL}</Typography>
            )}
          </Box>
          {days.map((d) => {
            const isToday = sameDay(d, now);
            return (
              <Box key={d.toISOString()} sx={{ textAlign: 'center', pb: 0.5 }}>
                <Typography sx={{ fontSize: DAY_LABEL, color: c.text.muted, fontWeight: 600, letterSpacing: '0.08em', lineHeight: 1.3, textTransform: 'uppercase' }}>
                  {WEEKDAY_LABEL_SHORT[d.getDay()]}
                </Typography>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxSizing: 'border-box', width: compact ? 26 : 32, height: compact ? 26 : 32, borderRadius: '50%', bgcolor: isToday ? c.accent.primary : 'transparent', color: isToday ? '#fff' : c.text.primary, fontWeight: isToday ? 600 : 500, fontSize: DAY_NUM, lineHeight: 1, mt: 0.25, boxShadow: isToday ? `0 0 0 1.5px ${c.bg.surface}, 0 0 0 3px ${c.accent.primary}` : 'none' }}>{d.getDate()}</Box>
              </Box>
            );
          })}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '64px repeat(7, 1fr)', position: 'relative', zIndex: 0 }}>
          {HOURS.map((hour, hourIdx) => (
            <React.Fragment key={hour}>
              {/* Hour label sits inside its row (top-aligned) rather than
                  straddling the line above it; that way the first row
                  doesn't clip "12 AM" and the labels never drift when the
                  body scrolls. Apple Calendar does the same. */}
              <Box sx={{
                height: SLOT_H, fontSize: ROW_LABEL,
                color: c.text.ghost, fontWeight: 500,
                textAlign: 'right', pr: 1, pt: 0.25,
                borderTop: hourIdx === 0 ? 'none' : `1px solid ${c.border.subtle}`,
              }}>
                {formatHourLabel(hour)}
              </Box>
              {days.map((d) => {
                const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                const evs = (eventsByDay.map.get(key) || []).filter((e) => e.date.getHours() === hour);
                const targetWeekday = d.getDay();
                return (
                  <Box
                    key={`${d.toISOString()}-${hour}`}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const wid = e.dataTransfer.getData('application/x-workflow-id');
                      if (!wid) return;
                      const wf = workflows.find((w) => w.id === wid);
                      if (!wf) return;
                      // Build the patched schedule: new hour, and for
                      // weekly schedules swap on_days to just the target
                      // weekday. Daily/monthly only get the new hour.
                      const sched = { ...wf.schedule, hour } as typeof wf.schedule;
                      if (sched.repeat_unit === 'week') sched.on_days = [targetWeekday];
                      dispatch(updateWorkflow({
                        id: wf.id,
                        patch: { schedule: sched as any },
                        ifMatch: wf.updated_at || null,
                      }));
                    }}
                    sx={{ height: SLOT_H, borderLeft: `1px solid ${c.border.subtle}`, borderTop: hourIdx === 0 ? 'none' : `1px solid ${c.border.subtle}`, position: 'relative', overflow: 'hidden' }}>
                    <EventStack
                      events={evs}
                      paused={allPaused}
                      now={now}
                      maxVisible={compact ? 1 : 3}
                      onSelectWorkflow={onSelectWorkflow}
                      eventFontSize={EVENT_FS}
                      onContextWorkflow={(wf, ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: wf }); }}
                    />
                  </Box>
                );
              })}
            </React.Fragment>
          ))}
          {nowColIdx >= 0 && (
            <Box sx={{
              position: 'absolute', pointerEvents: 'none', zIndex: 3,
              top: `${nowTopPx}px`,
              left: `calc(64px + ${nowColIdx} * ((100% - 64px) / 7))`,
              width: 'calc((100% - 64px) / 7)',
              height: 0, borderTop: `2px solid ${c.status.error}`,
            }}>
              <Box sx={{ position: 'absolute', left: -3, top: -4, width: 7, height: 7, borderRadius: '50%', bgcolor: c.status.error }} />
            </Box>
          )}
        </Box>
        {ctxMenuEl}
      </Box>
    );
  }

  if (view === 'Month') {
    const start = startOfMonthGrid(today);
    const cells = Array.from({ length: 35 }, (_, i) => addDays(start, i));
    const accent = c.accent.primary;
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        {/* Sticky weekday header so it stays visible even when the
            calendar body scrolls. Slightly bigger + tinted bg so it
            reads cleanly in both light and dark themes. */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', flexShrink: 0, position: 'sticky', top: 0, bgcolor: c.bg.surface, zIndex: 2, borderBottom: `1px solid ${c.border.subtle}`, pt: 1.25, pb: 0.6 }}>
          {WEEKDAY_LABEL_SHORT.map((l, i) => (
            <Typography key={`${l}-${i}`} sx={{ textAlign: 'center', fontSize: '0.74rem', color: c.text.muted, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{l}</Typography>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridTemplateRows: `repeat(5, minmax(${compact ? 70 : 96}px, 1fr))`, flex: 1, minHeight: 0, gap: 0, borderLeft: `1px solid ${c.border.subtle}` }}>
          {cells.map((d) => {
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const evs = eventsByDay.map.get(key) || [];
            const isToday = sameDay(d, now);
            const inMonth = d.getMonth() === today.getMonth();
            return (
              <Box key={d.toISOString()} sx={{ borderRight: `1px solid ${c.border.subtle}`, borderBottom: `1px solid ${c.border.subtle}`, p: 0.5, position: 'relative', overflow: 'hidden', bgcolor: inMonth ? 'transparent' : c.bg.elevated }}>
                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  {/* Out-of-month dates still need to be legible (Apple
                      Calendar shows them in a muted shade, not invisible).
                      Color tweak instead of opacity so dark themes stay
                      readable. */}
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxSizing: 'border-box', width: 22, height: 22, borderRadius: '50%', bgcolor: isToday ? accent : 'transparent', color: isToday ? '#fff' : inMonth ? c.text.primary : c.text.ghost, fontWeight: isToday ? 600 : 500, fontSize: '0.82rem', lineHeight: 1, boxShadow: isToday ? `0 0 0 1.5px ${c.bg.surface}, 0 0 0 3px ${accent}` : 'none' }}>{d.getDate()}</Box>
                </Box>
                {evs.slice(0, compact ? 3 : 4).map((e, idx) => (
                  <Box
                    key={`${e.workflow.id}-${idx}`}
                    onClick={() => onSelectWorkflow?.(e.workflow.id, e.date)}
                    onContextMenu={(ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: e.workflow }); }}
                    sx={{ mt: 0.3, display: 'flex', alignItems: 'center', gap: 0.5, fontSize: EVENT_FS, color: c.text.primary, cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', '&:hover': { color: accent } }}>
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', boxSizing: 'border-box', bgcolor: accent, flexShrink: 0 }} />
                    <span style={{ color: c.text.muted, flexShrink: 0 }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: 500 }}>{e.workflow.title}</span>
                  </Box>
                ))}
                {evs.length > (compact ? 3 : 4) && (
                  <MonthDayOverflow
                    date={d}
                    count={evs.length - (compact ? 3 : 4)}
                    events={evs}
                    now={now}
                    fontSize={EVENT_FS}
                    onSelectWorkflow={onSelectWorkflow}
                  />
                )}
              </Box>
            );
          })}
        </Box>
        {ctxMenuEl}
      </Box>
    );
  }

  // Apple-Calendar-style list: each day is a stacked group with the date as a
  // header and its events listed underneath, so a busy day stays readable top
  // to bottom instead of crammed beside a date column. Today renders even with
  // no events (shows a "No events today" placeholder)
  // so the list doesn't feel empty for new users. Off-screen day groups
  // unmount (useWindowedList) and leave a measured-height spacer behind, so a
  // dense schedule stays light no matter how far down you scroll.
  const accent = c.accent.primary;
  const visibleRows = rows.slice(windowing.start, windowing.end);
  return (
    <Box
      ref={windowing.setScrollEl}
      onScroll={windowing.onScroll}
      sx={{ display: 'flex', flexDirection: 'column', maxHeight: '100%', overflow: 'auto', overflowAnchor: 'auto', bgcolor: c.bg.surface }}>
      {rows.length === 0 && (
        <Typography sx={{ fontSize: '0.85rem', color: c.text.muted, textAlign: 'center', py: 3 }}>No scheduled</Typography>
      )}
      {windowing.topSpacer > 0 && (
        <Box aria-hidden sx={{ height: windowing.topSpacer, flexShrink: 0, overflowAnchor: 'none' }} />
      )}
      {visibleRows.map((row, i) => {
        const rowIdx = windowing.start + i;
        if (row.kind === 'header') {
          return (
            <Box
              key={row.id}
              data-wl-id={row.id}
              sx={{
                display: 'flex', alignItems: 'baseline', gap: 0.75,
                px: 2, pt: rowIdx === 0 ? 1.5 : 2, pb: 0.5,
                borderTop: rowIdx === 0 ? 'none' : `1px dashed ${c.border.subtle}`,
              }}>
              <Typography sx={{ fontSize: '1.15rem', fontWeight: 700, color: row.isToday ? accent : c.text.primary, lineHeight: 1, letterSpacing: '-0.01em' }}>
                {row.date.getDate()}
              </Typography>
              <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: row.isToday ? accent : c.text.secondary, lineHeight: 1 }}>
                {WEEKDAY_FULL[row.date.getDay()]}
              </Typography>
              <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, lineHeight: 1 }}>
                {row.date.toLocaleString('en', { month: 'short' })}
              </Typography>
            </Box>
          );
        }
        if (row.kind === 'empty') {
          return (
            <Box key={row.id} data-wl-id={row.id} sx={{ px: 2, pb: 1 }}>
              <Typography sx={{ fontSize: '0.85rem', color: c.text.ghost }}>No events today</Typography>
            </Box>
          );
        }
        const e = row.ev;
        return (
          <Box
            key={row.id}
            data-wl-id={row.id}
            onClick={() => onSelectWorkflow?.(e.workflow.id, e.date)}
            onContextMenu={(ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: e.workflow }); }}
            sx={{
              display: 'flex', alignItems: 'center', gap: 1.25,
              px: 2, py: 0.4,
              color: c.text.secondary, cursor: 'pointer',
              '&:hover .ev-title': { color: accent },
            }}>
            <Box sx={{ width: 3, alignSelf: 'stretch', minHeight: 22, bgcolor: accent, borderRadius: c.radius.sm, flexShrink: 0 }} />
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography className="ev-title" sx={{ fontSize: '0.9rem', fontWeight: 500, color: c.text.primary, lineHeight: 1.3 }}>{e.workflow.title}</Typography>
              <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, lineHeight: 1.3 }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</Typography>
            </Box>
          </Box>
        );
      })}
      {windowing.bottomSpacer > 0 && (
        <Box aria-hidden sx={{ height: windowing.bottomSpacer, flexShrink: 0, overflowAnchor: 'none' }} />
      )}
      {ctxMenuEl}
    </Box>
  );
}

// Apple Calendar style event stack: tiny bars in the hour cell, followed by a
// text overflow affordance when the hour has more runs than fit.
function EventStack({ events, paused, now, maxVisible, onSelectWorkflow, eventFontSize, onContextWorkflow }: {
  events: { workflow: Workflow; date: Date }[];
  paused?: boolean;
  now: Date;
  maxVisible: number;
  onSelectWorkflow?: (id: string, fireAt?: Date) => void;
  eventFontSize: string;
  onContextWorkflow?: (workflow: Workflow, e: React.MouseEvent) => void;
}) {
  const c = useClaudeTokens();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (events.length === 0) return null;
  const visible = events.slice(0, maxVisible);
  const rest = events.slice(maxVisible);
  const accent = c.accent.primary;

  return (
    <Box sx={{ position: 'absolute', left: 4, right: 4, top: 3, bottom: 2, zIndex: 1, display: 'flex', flexDirection: 'column', gap: 0.25, overflow: 'hidden' }}>
      {visible.map((event, idx) => {
        const timeLabel = formatTime(event.date.getHours(), event.date.getMinutes());
        return (
          <Tooltip key={`${event.workflow.id}-${event.date.getTime()}-${idx}`} title={<EventTooltipBody event={event} />} placement="top" arrow>
            <Box
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-workflow-id', event.workflow.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onSelectWorkflow?.(event.workflow.id, event.date)}
              onContextMenu={(e) => onContextWorkflow?.(event.workflow, e)}
              sx={{
                height: 15,
                bgcolor: accent,
                color: '#fff',
                border: `1px solid ${accent}`,
                borderRadius: c.radius.sm,
                px: 0.55, py: 0,
                fontSize: eventFontSize, fontWeight: 600, lineHeight: '13px',
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.35,
                opacity: paused ? 0.45 : 1,
                boxSizing: 'border-box',
                '&:hover': { bgcolor: accent },
              }}>
              <span style={{ display: 'block', lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{event.workflow.title}</span>
              <span style={{ display: 'block', lineHeight: '13px', color: 'inherit', opacity: 0.85, flexShrink: 0 }}>{timeLabel}</span>
            </Box>
          </Tooltip>
        );
      })}
      {rest.length > 0 && (
        <Box
          onClick={(e) => setAnchor(e.currentTarget)}
          role="button"
          sx={{
            alignSelf: 'flex-start',
            color: c.text.muted,
            fontSize: eventFontSize,
            fontWeight: 600,
            lineHeight: 1,
            cursor: 'pointer',
            px: 0.35,
            '&:hover': { color: accent },
          }}>
          {rest.length} more
        </Box>
      )}
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <Box sx={{ minWidth: 220, p: 1 }}>
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mb: 0.5 }}>
            {rest.length} more at this hour
          </Typography>
          {rest.map((e, idx) => (
            <Box
              key={`${e.workflow.id}-${idx}`}
              onClick={() => { setAnchor(null); onSelectWorkflow?.(e.workflow.id, e.date); }}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, py: 0.5, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', boxSizing: 'border-box', bgcolor: accent, flexShrink: 0 }} />
              <Typography sx={{ flex: 1, fontSize: '0.82rem', color: c.text.primary, fontWeight: 600 }}>{e.workflow.title}</Typography>
              <Typography sx={{ fontSize: '0.74rem', color: c.text.muted }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</Typography>
            </Box>
          ))}
        </Box>
      </Popover>
    </Box>
  );
}

// "+N more" on a packed month cell opens a scrollable popover listing every
// run that day, so a heavy day isn't a dead end. Past fires keep the hollow
// ring the cell rows use, for a consistent at-a-glance "already ran" read.
function MonthDayOverflow({ date, count, events, now, fontSize, onSelectWorkflow }: {
  date: Date;
  count: number;
  events: { workflow: Workflow; date: Date }[];
  now: Date;
  fontSize: string;
  onSelectWorkflow?: (id: string, fireAt?: Date) => void;
}) {
  const c = useClaudeTokens();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const accent = c.accent.primary;
  return (
    <>
      <Typography
        onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget); }}
        role="button"
        sx={{ fontSize, color: c.text.muted, mt: 0.3, pl: 1.4, cursor: 'pointer', '&:hover': { color: accent } }}>
        +{count} more
      </Typography>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}>
        <Box sx={{ minWidth: 240, maxHeight: 360, overflowY: 'auto', p: 1 }}>
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mb: 0.5 }}>
            {`${events.length} scheduled · ${date.toLocaleString('en', { weekday: 'short', month: 'short', day: 'numeric' })}`}
          </Typography>
          {events.map((e, idx) => (
            <Box
              key={`${e.workflow.id}-${idx}`}
              onClick={() => { setAnchor(null); onSelectWorkflow?.(e.workflow.id, e.date); }}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, py: 0.5, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', boxSizing: 'border-box', bgcolor: accent, flexShrink: 0 }} />
              <Typography sx={{ flex: 1, fontSize: '0.82rem', color: c.text.primary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.workflow.title}</Typography>
              <Typography sx={{ fontSize: '0.74rem', color: c.text.muted, flexShrink: 0 }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</Typography>
            </Box>
          ))}
        </Box>
      </Popover>
    </>
  );
}

function EventTooltipBody({ event }: { event: { workflow: Workflow; date: Date } }) {
  const wf = event.workflow;
  const status = wf.last_run_status;
  const cost = wf.cost_estimate?.last_run_usd;
  const monthly = wf.cost_estimate?.monthly_usd;
  return (
    <Box sx={{ fontSize: '0.72rem', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700 }}>{wf.title}</div>
      <div>{`Fires at ${formatTime(event.date.getHours(), event.date.getMinutes())}`}</div>
      {status && <div>{`Last run: ${status}`}</div>}
      {typeof cost === 'number' && cost > 0 && <div>{`Last run cost: $${cost.toFixed(4)}`}</div>}
      {typeof monthly === 'number' && monthly > 0 && <div>{`Est. monthly: $${monthly.toFixed(2)}`}</div>}
    </Box>
  );
}
