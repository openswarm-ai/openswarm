import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Popover from '@mui/material/Popover';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import type { Workflow } from '@/shared/state/workflowsSlice';
import { runWorkflowNow, deleteWorkflow, updateWorkflow, openWorkflowCard } from '@/shared/state/workflowsSlice';
import { addWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { WEEKDAY_FULL, WEEKDAY_LABEL_SHORT, addDays, sameDay, startOfMonthGrid, startOfWeek, fireTimesWithin, formatTime, formatHourLabel } from './scheduleUtils';

interface Props {
  view: 'Week' | 'Month' | 'List';
  density: 'compact' | 'roomy';
  onSelectWorkflow?: (id: string) => void;
  refDate?: Date;
}

// Both compact (popover) and roomy (hub) show the full 24 hours scrollable —
// the user explicitly wants midnight visible at the top, not "9am" as the
// starting hour. The scroll container caps the visible window.
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

export default function ScheduleCalendar({ view, density, onSelectWorkflow, refDate }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const workflows = useAppSelector((s) => Object.values(s.workflows.items));
  // Right-click menu: pinned position + the workflow whose pill was
  // clicked. Same anchor pattern as MUI's menu examples.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; workflow: Workflow } | null>(null);
  const closeMenu = () => setCtxMenu(null);
  const onRunNow = () => {
    if (!ctxMenu) return;
    dispatch(runWorkflowNow(ctxMenu.workflow.id));
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
  // refDate is recreated on every render unless the caller memoizes it,
  // which then trips the eventsByDay memo every paint. Pin the calendar
  // to a day-precision key so the heavy fireTimesWithin loop only re-runs
  // when the day or workflow set actually changed.
  const today = refDate || new Date();
  const dayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const compact = density === 'compact';

  const eventsByDay = useMemo(() => {
    const range = view === 'Month' ? 35 : view === 'Week' ? 7 : 14;
    const start = view === 'Month' ? startOfMonthGrid(today) : view === 'Week' ? startOfWeek(today) : today;
    const end = addDays(start, range - 1);
    const map = new Map<string, { workflow: Workflow; date: Date }[]>();
    for (const wf of workflows) {
      if (!wf.schedule.enabled) continue;
      const fires = fireTimesWithin(wf, start, end, 60);
      for (const d of fires) {
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const arr = map.get(key) || [];
        arr.push({ workflow: wf, date: d });
        map.set(key, arr);
      }
    }
    return { map, start, end };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows, view, dayKey]);

  const SLOT_H = compact ? 32 : 44;
  const ROW_LABEL = compact ? '0.7rem' : '0.74rem';
  const DAY_NUM = compact ? '0.95rem' : '1.15rem';
  const DAY_LABEL = compact ? '0.66rem' : '0.72rem';
  const EVENT_FS = compact ? '0.7rem' : '0.78rem';

  if (view === 'Week') {
    const start = startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const HOURS = HOURS_24;
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
        <Box sx={{ display: 'grid', gridTemplateColumns: '64px repeat(7, 1fr)', gap: 0, position: 'sticky', top: 0, bgcolor: c.bg.surface, zIndex: 2, pb: 0.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', pr: 1, pb: 0.5 }}>
            {!compact && (
              <Typography sx={{ fontSize: '0.62rem', color: c.text.ghost, fontWeight: 500 }}>{TZ_LABEL}</Typography>
            )}
          </Box>
          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <Box key={d.toISOString()} sx={{ textAlign: 'center', pb: 0.5 }}>
                <Typography sx={{ fontSize: DAY_LABEL, color: c.text.muted, fontWeight: 600, letterSpacing: '0.08em', lineHeight: 1.3, textTransform: 'uppercase' }}>
                  {WEEKDAY_LABEL_SHORT[d.getDay()]}
                </Typography>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: compact ? 30 : 38, height: compact ? 30 : 38, borderRadius: '50%', bgcolor: isToday ? c.accent.primary : 'transparent', color: isToday ? '#fff' : c.text.primary, fontWeight: isToday ? 700 : 500, fontSize: DAY_NUM, mt: 0.25 }}>{d.getDate()}</Box>
              </Box>
            );
          })}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '64px repeat(7, 1fr)', borderTop: `1px solid ${c.border.subtle}` }}>
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
                    sx={{ height: SLOT_H, borderLeft: `1px solid ${c.border.subtle}`, borderTop: hourIdx === 0 ? 'none' : `1px solid ${c.border.subtle}`, position: 'relative' }}>
                    <EventStack
                      events={evs}
                      onSelectWorkflow={onSelectWorkflow}
                      eventFontSize={EVENT_FS}
                      onContextWorkflow={(wf, ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: wf }); }}
                    />
                  </Box>
                );
              })}
            </React.Fragment>
          ))}
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
      <Box sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Sticky weekday header so it stays visible even when the
            calendar body scrolls. Slightly bigger + tinted bg so it
            reads cleanly in both light and dark themes. */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', position: 'sticky', top: 0, bgcolor: c.bg.surface, zIndex: 2, borderBottom: `1px solid ${c.border.subtle}`, py: 0.6 }}>
          {WEEKDAY_LABEL_SHORT.map((l, i) => (
            <Typography key={`${l}-${i}`} sx={{ textAlign: 'center', fontSize: '0.74rem', color: c.text.secondary, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{l}</Typography>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0, borderLeft: `1px solid ${c.border.subtle}` }}>
          {cells.map((d) => {
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const evs = eventsByDay.map.get(key) || [];
            const isToday = sameDay(d, today);
            const inMonth = d.getMonth() === today.getMonth();
            return (
              <Box key={d.toISOString()} sx={{ minHeight: compact ? 70 : 96, borderRight: `1px solid ${c.border.subtle}`, borderBottom: `1px solid ${c.border.subtle}`, p: 0.5, position: 'relative', overflow: 'hidden', bgcolor: inMonth ? 'transparent' : c.bg.elevated }}>
                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  {/* Out-of-month dates still need to be legible (Apple
                      Calendar shows them in a muted shade, not invisible).
                      Color tweak instead of opacity so dark themes stay
                      readable. */}
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, borderRadius: '50%', bgcolor: isToday ? accent : 'transparent', color: isToday ? '#fff' : inMonth ? c.text.primary : c.text.ghost, fontWeight: isToday ? 700 : 500, fontSize: '0.82rem', px: 0.5 }}>{d.getDate()}</Box>
                </Box>
                {evs.slice(0, compact ? 3 : 4).map((e, idx) => (
                  <Box
                    key={`${e.workflow.id}-${idx}`}
                    onClick={() => onSelectWorkflow?.(e.workflow.id)}
                    onContextMenu={(ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: e.workflow }); }}
                    sx={{ mt: 0.3, display: 'flex', alignItems: 'center', gap: 0.5, fontSize: EVENT_FS, color: c.text.primary, cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', '&:hover': { color: accent } }}>
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: accent, flexShrink: 0 }} />
                    <span style={{ color: c.text.muted, flexShrink: 0 }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: 500 }}>{e.workflow.title}</span>
                  </Box>
                ))}
                {evs.length > (compact ? 3 : 4) && (
                  <Typography sx={{ fontSize: EVENT_FS, color: c.text.muted, mt: 0.3, pl: 1.4 }}>+{evs.length - (compact ? 3 : 4)} more</Typography>
                )}
              </Box>
            );
          })}
        </Box>
        {ctxMenuEl}
      </Box>
    );
  }

  // Apple-Calendar-style list: big day number + weekday on the left, a
  // vertical colored bar separating it from events on the right. Today
  // renders even with no events (shows a "No events today" placeholder)
  // so the list doesn't feel empty for new users.
  const upcoming: { date: Date; events: { workflow: Workflow; date: Date }[]; isToday: boolean }[] = [];
  for (let i = 0; i < 14; i += 1) {
    const day = addDays(today, i);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    const arr = eventsByDay.map.get(key) || [];
    const isToday = sameDay(day, today);
    if (arr.length || isToday) upcoming.push({ date: day, events: arr, isToday });
  }
  const accent = c.accent.primary;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.lg}px`, overflow: 'hidden', bgcolor: c.bg.surface }}>
      {upcoming.length === 0 && (
        <Typography sx={{ fontSize: '0.85rem', color: c.text.muted, textAlign: 'center', py: 3 }}>No scheduled workflows</Typography>
      )}
      {upcoming.map(({ date, events, isToday }, rowIdx) => (
        <Box
          key={date.toISOString()}
          sx={{
            display: 'flex', alignItems: 'stretch',
            borderTop: rowIdx === 0 ? 'none' : `1px dashed ${c.border.subtle}`,
            minHeight: 64,
          }}>
          <Box sx={{ width: 96, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0.75, pl: 2, pr: 1.25 }}>
            <Typography sx={{ fontSize: '1.55rem', fontWeight: 600, color: isToday ? accent : c.text.primary, lineHeight: 1, letterSpacing: '-0.01em' }}>
              {date.getDate()}
            </Typography>
            <Box>
              <Typography sx={{ fontSize: '0.78rem', color: isToday ? accent : c.text.secondary, fontWeight: 500, lineHeight: 1.2 }}>
                {date.toLocaleString('en', { month: 'short' })}
              </Typography>
              <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, lineHeight: 1.2 }}>{WEEKDAY_FULL[date.getDay()]}</Typography>
            </Box>
          </Box>
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', py: 1, pr: 2 }}>
            {events.length === 0 && (
              <Typography sx={{ fontSize: '0.85rem', color: c.text.ghost }}>No events today</Typography>
            )}
            {events.map((e, idx) => (
              <Tooltip key={`${e.workflow.id}-${idx}`} title={<EventTooltipBody event={e} />} placement="right" arrow>
                <Box
                  onClick={() => onSelectWorkflow?.(e.workflow.id)}
                  onContextMenu={(ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: e.workflow }); }}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1.25,
                    py: 0.4,
                    fontSize: '0.88rem', color: c.text.secondary, cursor: 'pointer',
                    '&:hover .ev-title': { color: accent },
                  }}>
                  <Box sx={{ width: 3, alignSelf: 'stretch', minHeight: 22, bgcolor: accent, borderRadius: 1, flexShrink: 0 }} />
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    <Typography className="ev-title" sx={{ fontSize: '0.9rem', fontWeight: 500, color: c.text.primary, lineHeight: 1.3 }}>{e.workflow.title}</Typography>
                    <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, lineHeight: 1.3 }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</Typography>
                  </Box>
                </Box>
              </Tooltip>
            ))}
          </Box>
        </Box>
      ))}
      {ctxMenuEl}
    </Box>
  );
}

// Apple Calendar style event chip: 3px colored left-bar + faintly-tinted
// background + readable text. One chip per cell with a "+N" badge for
// overflow; clicking it opens a popover listing all events that hour.
function EventStack({ events, onSelectWorkflow, eventFontSize, onContextWorkflow }: {
  events: { workflow: Workflow; date: Date }[];
  onSelectWorkflow?: (id: string) => void;
  eventFontSize: string;
  onContextWorkflow?: (workflow: Workflow, e: React.MouseEvent) => void;
}) {
  const c = useClaudeTokens();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (events.length === 0) return null;
  const first = events[0];
  const rest = events.slice(1);
  const accent = c.accent.primary;

  // Time string is part of the chip so a glance tells you both what and
  // when, matching Apple's "Title, 1pm" pattern. Chip is slim (height ~22)
  // not slot-stretching, since OpenSwarm events fire at a single instant.
  const timeLabel = formatTime(first.date.getHours(), first.date.getMinutes());
  return (
    <>
      <Tooltip title={<EventTooltipBody event={first} />} placement="top" arrow>
        <Box
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-workflow-id', first.workflow.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => onSelectWorkflow?.(first.workflow.id)}
          onContextMenu={(e) => onContextWorkflow?.(first.workflow, e)}
          sx={{
            position: 'absolute',
            left: 2, right: rest.length > 0 ? 24 : 2, top: 2,
            height: 22,
            bgcolor: accent + '14',
            color: c.text.primary,
            borderLeft: `3px solid ${accent}`,
            borderRadius: '4px',
            px: 0.65, py: 0,
            fontSize: eventFontSize, fontWeight: 500,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5,
            '&:hover': { bgcolor: accent + '22' },
          }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{first.workflow.title}</span>
          <span style={{ color: 'inherit', opacity: 0.7, flexShrink: 0 }}>{timeLabel}</span>
        </Box>
      </Tooltip>
      {rest.length > 0 && (
        <Box
          onClick={(e) => setAnchor(e.currentTarget)}
          role="button"
          sx={{
            position: 'absolute',
            right: 2, top: 2,
            height: 22,
            minWidth: 20, px: 0.4,
            bgcolor: accent + '22',
            color: accent,
            borderRadius: '4px',
            fontSize: eventFontSize, fontWeight: 700,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            '&:hover': { bgcolor: accent + '33' },
          }}>
          +{rest.length}
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
            {events.length} runs at this hour
          </Typography>
          {events.map((e, idx) => (
            <Box
              key={`${e.workflow.id}-${idx}`}
              onClick={() => { setAnchor(null); onSelectWorkflow?.(e.workflow.id); }}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, py: 0.5, borderRadius: `${c.radius.md}px`, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: c.accent.primary }} />
              <Typography sx={{ flex: 1, fontSize: '0.82rem', color: c.text.primary, fontWeight: 600 }}>{e.workflow.title}</Typography>
              <Typography sx={{ fontSize: '0.74rem', color: c.text.muted }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</Typography>
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
