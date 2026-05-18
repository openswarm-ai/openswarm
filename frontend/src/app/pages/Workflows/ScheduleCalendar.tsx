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
import { WEEKDAY_LABEL, WEEKDAY_LABEL_SHORT, addDays, sameDay, startOfMonthGrid, startOfWeek, fireTimesWithin, formatTime, formatHourLabel } from './scheduleUtils';

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
    dispatch(openWorkflowCard({ workflowId: ctxMenu.workflow.id, view: 'edit', editFacet: 'Schedule' }));
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

  const SLOT_H = compact ? 28 : 36;
  const ROW_LABEL = compact ? '0.72rem' : '0.78rem';
  const DAY_NUM = compact ? '0.85rem' : '0.95rem';
  const DAY_LABEL = compact ? '0.7rem' : '0.78rem';
  const EVENT_FS = compact ? '0.72rem' : '0.82rem';

  if (view === 'Week') {
    const start = startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const HOURS = HOURS_24;
    const TZ_LABEL = (() => {
      try {
        const offset = -new Date().getTimezoneOffset() / 60;
        return `GMT${offset >= 0 ? '+' : ''}${offset.toString().padStart(2, '0').replace('.', ':')}`;
      } catch { return ''; }
    })();
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', color: c.text.secondary }}>
        {/* Day headers — full names in roomy, single letter in compact */}
        <Box sx={{ display: 'grid', gridTemplateColumns: '64px repeat(7, 1fr)', gap: 0, position: 'sticky', top: 0, bgcolor: c.bg.surface, zIndex: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', pr: 1, pb: 0.5 }}>
            {!compact && (
              <Typography sx={{ fontSize: '0.66rem', color: c.text.ghost, fontWeight: 500 }}>{TZ_LABEL}</Typography>
            )}
          </Box>
          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <Box key={d.toISOString()} sx={{ textAlign: 'center', pb: 0.5 }}>
                <Typography sx={{ fontSize: DAY_LABEL, color: isToday ? c.accent.primary : c.text.muted, fontWeight: 700, letterSpacing: '0.06em', lineHeight: 1.3 }}>
                  {WEEKDAY_LABEL_SHORT[d.getDay()]}
                </Typography>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: compact ? 28 : 34, height: compact ? 28 : 34, borderRadius: '50%', bgcolor: isToday ? c.accent.primary : 'transparent', color: isToday ? '#fff' : c.text.primary, fontWeight: 700, fontSize: DAY_NUM, mt: 0.25 }}>{d.getDate()}</Box>
              </Box>
            );
          })}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '64px repeat(7, 1fr)', borderTop: `1px solid ${c.border.subtle}` }}>
          {HOURS.map((hour) => (
            <React.Fragment key={hour}>
              <Box sx={{
                height: SLOT_H, fontSize: ROW_LABEL,
                color: c.text.ghost, fontWeight: 500,
                textAlign: 'right', pr: 1,
                position: 'relative', top: -7,  // tuck label so it sits on the gridline, not in the cell
                borderTop: `1px solid ${c.border.subtle}`,
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
                    sx={{ height: SLOT_H, borderLeft: `1px solid ${c.border.subtle}`, borderTop: `1px solid ${c.border.subtle}`, position: 'relative' }}>
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
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', mb: 0.5 }}>
          {WEEKDAY_LABEL_SHORT.map((l, i) => (
            <Typography key={`${l}-${i}`} sx={{ textAlign: 'center', fontSize: DAY_LABEL, color: c.text.muted, fontWeight: 600, letterSpacing: '0.06em' }}>{l}</Typography>
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0 }}>
          {cells.map((d) => {
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const evs = eventsByDay.map.get(key) || [];
            const isToday = sameDay(d, today);
            const inMonth = d.getMonth() === today.getMonth();
            return (
              <Box key={d.toISOString()} sx={{ minHeight: compact ? 64 : 88, borderRight: `1px solid ${c.border.subtle}`, borderBottom: `1px solid ${c.border.subtle}`, p: 0.5, opacity: inMonth ? 1 : 0.45, position: 'relative', overflow: 'hidden' }}>
                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, borderRadius: '50%', bgcolor: isToday ? c.accent.primary : 'transparent', color: isToday ? '#fff' : c.text.secondary, fontWeight: isToday ? 700 : 500, fontSize: DAY_NUM, px: 0.5 }}>{d.getDate()}</Box>
                </Box>
                {evs.slice(0, compact ? 3 : 5).map((e, idx) => (
                  <Box
                    key={`${e.workflow.id}-${idx}`}
                    onClick={() => onSelectWorkflow?.(e.workflow.id)}
                    onContextMenu={(ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: e.workflow }); }}
                    sx={{ mt: 0.3, display: 'flex', alignItems: 'center', gap: 0.4, fontSize: EVENT_FS, color: c.text.secondary, cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', '&:hover': { color: c.accent.primary } }}>
                    <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: c.accent.primary, flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {formatTime(e.date.getHours(), e.date.getMinutes())} {e.workflow.title}
                    </span>
                  </Box>
                ))}
                {evs.length > (compact ? 3 : 5) && (
                  <Typography sx={{ fontSize: EVENT_FS, color: c.text.muted, mt: 0.3 }}>+{evs.length - (compact ? 3 : 5)} more</Typography>
                )}
              </Box>
            );
          })}
        </Box>
        {ctxMenuEl}
      </Box>
    );
  }

  const upcoming: { date: Date; events: { workflow: Workflow; date: Date }[] }[] = [];
  for (let i = 0; i < 14; i += 1) {
    const day = addDays(today, i);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    const arr = eventsByDay.map.get(key) || [];
    if (arr.length) upcoming.push({ date: day, events: arr });
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {upcoming.length === 0 && (
        <Typography sx={{ fontSize: '0.85rem', color: c.text.muted, textAlign: 'center', py: 2 }}>No scheduled workflows</Typography>
      )}
      {upcoming.map(({ date, events }) => (
        <Box key={date.toISOString()} sx={{ display: 'flex', gap: 1.25 }}>
          <Box sx={{ width: 52, flexShrink: 0, textAlign: 'center', borderRight: `1px solid ${c.border.subtle}`, pr: 0.75 }}>
            <Typography sx={{ fontSize: '1.1rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.1 }}>{date.getDate()}</Typography>
            <Typography sx={{ fontSize: '0.7rem', color: c.text.muted, fontWeight: 600 }}>{date.toLocaleString('en', { month: 'short' })}</Typography>
            <Typography sx={{ fontSize: '0.7rem', color: c.text.muted }}>{WEEKDAY_LABEL[date.getDay()]}</Typography>
          </Box>
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0.4 }}>
            {events.map((e, idx) => (
              <Tooltip key={`${e.workflow.id}-${idx}`} title={<EventTooltipBody event={e} />} placement="right" arrow>
                <Box
                  onClick={() => onSelectWorkflow?.(e.workflow.id)}
                  onContextMenu={(ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, workflow: e.workflow }); }}
                  sx={{ fontSize: '0.85rem', color: c.text.secondary, cursor: 'pointer', '&:hover': { color: c.accent.primary } }}>
                  <strong style={{ color: c.text.primary }}>{e.workflow.title}</strong>
                  <span style={{ color: c.text.muted, marginLeft: 8 }}>{formatTime(e.date.getHours(), e.date.getMinutes())}</span>
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

// Renders the events for a single calendar cell. Up to one pill is shown
// inline; everything else collapses into a "+N" chip that opens a popover
// with the full list, so the calendar stays readable at high schedule
// density without truncating workflow titles.
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
            left: 3, right: rest.length > 0 ? 28 : 3, top: 3, bottom: 3,
            bgcolor: c.accent.primary + '1f',
            color: c.accent.primary,
            border: `1px solid ${c.accent.primary}`,
            borderRadius: 999,
            px: 1.1, py: 0,
            fontSize: eventFontSize, fontWeight: 600,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            '&:hover': { bgcolor: c.accent.primary + '33' },
          }}>
          {first.workflow.title}
        </Box>
      </Tooltip>
      {rest.length > 0 && (
        <Box
          onClick={(e) => setAnchor(e.currentTarget)}
          role="button"
          sx={{
            position: 'absolute',
            right: 3, top: 3, bottom: 3,
            width: 22,
            bgcolor: c.accent.primary,
            color: '#fff',
            borderRadius: 999,
            fontSize: eventFontSize, fontWeight: 700,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            '&:hover': { filter: 'brightness(1.1)' },
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
