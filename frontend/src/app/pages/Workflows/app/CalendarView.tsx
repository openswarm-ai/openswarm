import React, { useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { useAppSelector } from '@/shared/hooks';
import { startOfWeek, startOfMonthGrid, addDays, sameDay } from '@/app/pages/Workflows/scheduleUtils';
import { useCalendarOccurrences } from './useCalendarOccurrences';
import { colorForWorkflow, useWC, type WCPalette } from './uiKit';
import type { AppNav } from './types';

interface Occ { wfId: string; title: string; at: Date; color: string; }
interface DayPop { title: string; runs: Occ[]; x: number; y: number; }
type OpenDayPop = (title: string, runs: Occ[], e: React.MouseEvent) => void;

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const POP_W = 240;

function miniTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

const tabBtn = (active: boolean, WC: WCPalette): CSSProperties => ({
  padding: '5px 13px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
  background: active ? WC.paper : 'transparent', color: active ? WC.ink : WC.muted,
  boxShadow: active ? WC.shadow.sm : 'none',
});

const CalendarView: React.FC<{ nav: AppNav }> = ({ nav }) => {
  const WC = useWC();
  const items = useAppSelector((s) => s.workflows.items);
  // Tick the clock so the now-line and "today" highlight stay live instead of
  // freezing at first render.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);
  const ref = nav.refDate;
  const refKey = `${ref.getFullYear()}-${ref.getMonth()}-${ref.getDate()}`;

  // Window of occurrences spanning the visible month grid (covers week too).
  // Fired times come from the backend's recurrence engine, not a JS reimpl, so
  // the grid matches what actually runs (timezone + last-day-of-month aware).
  const { fromIso, toIso } = useMemo(() => {
    const from = startOfMonthGrid(ref);
    return { fromIso: from.toISOString(), toIso: addDays(from, 42).toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey]);
  const { events } = useCalendarOccurrences(fromIso, toIso);
  const occ = useMemo<Occ[]>(() => {
    const out: Occ[] = [];
    for (const e of events) {
      const wf = items[e.workflowId];
      if (!wf || wf.unsaved) continue;
      out.push({ wfId: wf.id, title: wf.title || 'Untitled', at: e.at, color: colorForWorkflow(wf) });
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [events, items]);

  const occByDay = useMemo(() => {
    const map = new Map<string, Occ[]>();
    for (const o of occ) {
      const key = `${o.at.getFullYear()}-${o.at.getMonth()}-${o.at.getDate()}`;
      const arr = map.get(key) || [];
      arr.push(o);
      map.set(key, arr);
    }
    return map;
  }, [occ]);
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  const title = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const step = (dir: number) => {
    if (nav.calView === 'week') nav.setRefDate(addDays(ref, dir * 7));
    else nav.setRefDate(new Date(ref.getFullYear(), ref.getMonth() + dir, 1));
  };

  // Click "+N more" to peek a day's/hour's full run list. position:fixed via a
  // body portal so it isn't reparented by the zoomed/panned canvas transform.
  const [dayPop, setDayPop] = useState<DayPop | null>(null);
  const openDayPop: OpenDayPop = (popTitle, runs, e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const x = Math.min(r.left, vw - POP_W - 12);
    let y = r.bottom + 6;
    if (y > vh - 220) y = Math.max(12, r.top - 8 - 300);
    setDayPop({ title: popTitle, runs, x, y });
  };
  const selectFromPop = (id: string) => { setDayPop(null); nav.selectWorkflow(id); };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: WC.page }}>
      <div style={{ flex: 'none', padding: '14px 26px', borderBottom: `1px solid ${WC.line}`, display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={() => nav.setRefDate(new Date())} style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.14)`, borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, color: WC.ink, cursor: 'pointer' }}>Today</button>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => step(-1)} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid rgba(${WC.inkRGB},0.12)`, background: WC.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WC.ink3 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 6l-6 6 6 6" /></svg></button>
          <button onClick={() => step(1)} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid rgba(${WC.inkRGB},0.12)`, background: WC.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WC.ink3 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg></button>
        </div>
        <h1 style={{ margin: 0, fontFamily: "'Newsreader',serif", fontSize: 22, fontWeight: 600, color: WC.ink, letterSpacing: '-0.01em' }}>{title}</h1>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', background: WC.inset, border: `1px solid ${WC.line}`, borderRadius: 9, padding: 3, gap: 2 }}>
          <button onClick={() => nav.setCalView('week')} style={tabBtn(nav.calView === 'week', WC)}>Week</button>
          <button onClick={() => nav.setCalView('month')} style={tabBtn(nav.calView === 'month', WC)}>Month</button>
        </div>
      </div>

      {nav.calView === 'month'
        ? <MonthGrid ref0={ref} now={now} occByDay={occByDay} dayKey={dayKey} onSelect={nav.selectWorkflow} openDayPop={openDayPop} />
        : <WeekGrid ref0={ref} now={now} occByDay={occByDay} dayKey={dayKey} onSelect={nav.selectWorkflow} openDayPop={openDayPop} />}

      {dayPop && createPortal(
        <div onClick={() => setDayPop(null)} style={{ position: 'fixed', inset: 0, zIndex: 2147483600 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: dayPop.x, top: dayPop.y, width: POP_W, maxHeight: 320, overflowY: 'auto', background: WC.paper, border: `1px solid ${WC.line2}`, borderRadius: WC.radius.lg, boxShadow: WC.shadow.lg, padding: 12 }}>
            <div style={{ fontFamily: "'Newsreader',serif", fontSize: 15, fontWeight: 500, color: WC.ink, marginBottom: 10, padding: '0 2px' }}>{dayPop.title}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {dayPop.runs.map((r, i) => (
                <div key={i} onClick={() => selectFromPop(r.wfId)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 7px', borderRadius: 8, cursor: 'pointer' }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: r.color, flex: 'none' }} />
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: WC.ink4, flex: 'none', minWidth: 52 }}>{miniTime(r.at)}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: WC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

interface GridProps {
  ref0: Date; now: Date;
  occByDay: Map<string, Occ[]>;
  dayKey: (d: Date) => string;
  onSelect: (id: string) => void;
  openDayPop: OpenDayPop;
}

const moreStyle = (WC: WCPalette): CSSProperties => ({
  fontSize: 10.5, fontWeight: 600, color: WC.muted, padding: '2px 3px', borderRadius: 5,
  cursor: 'pointer', alignSelf: 'flex-start', border: 'none', background: 'transparent',
});

const MonthGrid: React.FC<GridProps> = ({ ref0, now, occByDay, dayKey, onSelect, openDayPop }) => {
  const WC = useWC();
  const start = startOfMonthGrid(ref0);
  // Only as many weeks as the month actually spans (5 or 6), like the design,
  // so rows aren't squashed by a dangling extra week of next-month days.
  const monthEnd = new Date(ref0.getFullYear(), ref0.getMonth() + 1, 0);
  const weeks = Math.ceil((Math.round((monthEnd.getTime() - start.getTime()) / 86400000) + 1) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  const month = ref0.getMonth();

  // Cells shrink with the window, so a fixed cap clips. Measure the real row and
  // "+more" heights off hidden probes (font metrics vary), then fit only events
  // that fully fit, the rest roll into "+N more". No guessed pixel constants.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const probeEventRef = useRef<HTMLDivElement | null>(null);
  const probeMoreRef = useRef<HTMLSpanElement | null>(null);
  const [rowH, setRowH] = useState(0);
  const [eventH, setEventH] = useState(18);
  const [moreH, setMoreH] = useState(18);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      setRowH(el.clientHeight / weeks);
      if (probeEventRef.current) setEventH(probeEventRef.current.offsetHeight);
      if (probeMoreRef.current) setMoreH(probeMoreRef.current.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);
  const GAP = 2; // events-container row gap
  const CELL_OVERHEAD = 39; // number row (27) + vertical padding (12), our own fixed pixels
  const contentH = rowH - CELL_OVERHEAD;
  const fitNoMore = Math.max(0, Math.floor((contentH + GAP) / (eventH + GAP)));
  const fitWithMore = Math.max(0, Math.floor((contentH + 1 - moreH) / (eventH + GAP)));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div aria-hidden style={{ position: 'absolute', top: -9999, left: -9999, visibility: 'hidden', pointerEvents: 'none' }}>
        <div ref={probeEventRef} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '1px 3px' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%' }} />
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>12:00am</span>
          <span style={{ fontSize: 11 }}>Sample</span>
        </div>
        <span ref={probeMoreRef} style={moreStyle(WC)}>+0 more</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', flex: 'none', borderBottom: `1px solid ${WC.line}` }}>
        {DOW.map((d) => <div key={d} style={{ textAlign: 'center', padding: '9px 0', fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, letterSpacing: '0.06em', color: WC.muted2 }}>{d}</div>)}
      </div>
      <div ref={gridRef} style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gridAutoRows: '1fr', minHeight: 0 }}>
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === month;
          const isToday = sameDay(d, now);
          const runs = occByDay.get(dayKey(d)) || [];
          const shown = runs.length <= fitNoMore ? runs : runs.slice(0, fitWithMore);
          const moreCount = runs.length - shown.length;
          return (
            <div key={i} style={{ borderRight: `1px solid rgba(${WC.inkRGB},0.06)`, borderBottom: `1px solid rgba(${WC.inkRGB},0.06)`, padding: '6px 8px', background: isToday ? 'rgba(194,90,54,0.05)' : (inMonth ? WC.paper : WC.inset), display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              <div style={{ display: 'flex', marginBottom: 3 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', background: isToday ? WC.accent : 'transparent' }}>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, fontWeight: isToday ? 700 : 500, lineHeight: 1, color: isToday ? '#fff' : (inMonth ? WC.ink3 : WC.faint) }}>{d.getDate()}</span>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
                {shown.map((r, ri) => (
                  <div key={ri} onClick={() => onSelect(r.wfId)} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', borderRadius: 4, padding: '1px 3px' }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: r.color, flex: 'none' }} />
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: WC.ink4, flex: 'none' }}>{miniTime(r.at)}</span>
                    <span style={{ fontSize: 11, color: WC.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                  </div>
                ))}
              </div>
              {moreCount > 0 && (
                <span
                  onClick={(e) => openDayPop(d.toLocaleDateString([], { month: 'long', day: 'numeric' }), runs, e)}
                  style={{ ...moreStyle(WC), flex: 'none', marginTop: 1 }}
                >+{moreCount} more</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const WeekGrid: React.FC<GridProps> = ({ ref0, now, occByDay, dayKey, onSelect, openDayPop }) => {
  const WC = useWC();
  const start = startOfWeek(ref0);
  const startMs = start.getTime();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_H = 44;

  useEffect(() => {
    // Scroll to ~2h before now once per mount / week change. Keying this on the
    // fresh `now`/`start` objects re-ran it on every render, so any background
    // re-render (a live run streaming, ongoing-runs updating) yanked the scroll
    // back up, you could never sit at the bottom. Key off the stable week ms.
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, (new Date().getHours() - 2) * ROW_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMs]);

  const nowFrac = (now.getHours() * 60 + now.getMinutes()) / 60 % 1;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,1fr)', flex: 'none', borderBottom: `1px solid ${WC.line}`, paddingRight: 9 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: WC.muted2 }} />
        {days.map((d, i) => {
          const isToday = sameDay(d, now);
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 7px', borderLeft: `1px solid rgba(${WC.inkRGB},0.06)` }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.04em', color: WC.muted2 }}>{DOW[d.getDay()]}</span>
              <div style={{ width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 3, flex: 'none', background: isToday ? WC.accent : 'transparent' }}>
                <span style={{ fontFamily: "'Newsreader',serif", fontSize: 18, fontWeight: 500, lineHeight: 1, color: isToday ? '#fff' : WC.ink }}>{d.getDate()}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,1fr)', borderBottom: `1px solid rgba(${WC.inkRGB},0.05)`, minHeight: ROW_H }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '5px 8px 0 0', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: WC.muted2 }}>{hourLabel(h)}</div>
            {days.map((d, di) => {
              const runs = (occByDay.get(dayKey(d)) || []).filter((r) => r.at.getHours() === h);
              const isNow = sameDay(d, now) && now.getHours() === h;
              return (
                <div key={di} style={{ position: 'relative', borderLeft: `1px solid rgba(${WC.inkRGB},0.06)`, padding: '2px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {isNow && <>
                    <div style={{ position: 'absolute', left: -4, top: nowFrac * ROW_H - 4, width: 8, height: 8, borderRadius: '50%', background: WC.accent, zIndex: 4 }} />
                    <div style={{ position: 'absolute', left: 0, right: 0, top: nowFrac * ROW_H, height: 2, background: WC.accent, zIndex: 3 }} />
                  </>}
                  {runs.slice(0, 3).map((r, ri) => (
                    <div key={ri} onClick={() => onSelect(r.wfId)} style={{ display: 'flex', alignItems: 'center', background: r.color, color: '#fff', borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 600, cursor: 'pointer', lineHeight: 1.2, overflow: 'hidden' }}>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                      <span style={{ marginLeft: 'auto', paddingLeft: 6, opacity: 0.85, flex: 'none' }}>{miniTime(r.at)}</span>
                    </div>
                  ))}
                  {runs.length > 3 && (
                    <span
                      onClick={(e) => openDayPop(`${DOW[d.getDay()]} ${d.getDate()} · ${hourLabel(h)}`, runs, e)}
                      style={{ ...moreStyle(WC), fontSize: 10 }}
                    >{runs.length - 3} more</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default CalendarView;
