import React, { useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { runMissedRuns, dismissMissedRuns } from '@/shared/state/missedRunsSlice';
import { openWorkflowMonitor } from '@/shared/state/dashboardLayoutSlice';
import { useCalendarOccurrences } from './useCalendarOccurrences';
import { colorForWorkflow, useWC, statusChip, statusDot } from './uiKit';
import { clockOf, whenText } from './model';
import WorkflowTitle from './WorkflowTitle';
import type { AppNav } from './types';

interface ComingRun { wfId: string; title: string; time: string; sortKey: number; steps: number; color: string; }
interface ComingGroup { key: string; dayNum: number; dow: string; runs: ComingRun[]; countLabel: string; }
const COMING_CAP = 3;

const HomeView: React.FC<{ nav: AppNav }> = ({ nav }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.workflows.items);
  const allRuns = useAppSelector((s) => s.workflows.allRuns);
  const active = useAppSelector((s) => s.workflows.active);
  const missed = useAppSelector((s) => s.missedRuns.items);
  const [missedExpanded, setMissedExpanded] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());

  const now = new Date();
  const todayLabel = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  // Animate only AI-driven renames; a user-renamed workflow (auto_named false) snaps.
  const animateOf = (wfId: string) => items[wfId]?.auto_named !== false;

  const ongoing = useMemo(() => active.map((a) => {
    const wf = items[a.workflow_id];
    const run = allRuns.find((r) => r.id === a.run_id);
    const total = wf?.steps.length || 0;
    const idx = run?.active_step_idx ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round(((idx + 1) / total) * 100)) : 10;
    return {
      wfId: a.workflow_id,
      title: wf?.title || a.title || 'Workflow',
      color: wf ? colorForWorkflow(wf) : WC.accent,
      stepLabel: total > 0 ? `Step ${Math.min(idx + 1, total)}/${total}` : 'Running',
      pct,
      nowText: run?.last_tool_label || 'Working…',
      clock: a.started_at ? clockOf(new Date(a.started_at)) : '',
    };
  }), [active, items, allRuns]);

  // Fetch the 7-day window from the backend's recurrence engine (single source
  // of truth) instead of recomputing fire times in JS.
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const { fromIso, toIso } = useMemo(() => {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    return { fromIso: from.toISOString(), toIso: new Date(from.getTime() + 7 * 86400000).toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);
  const { events } = useCalendarOccurrences(fromIso, toIso);
  const comingGroups = useMemo<ComingGroup[]>(() => {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const byDay = new Map<string, ComingRun[]>();
    for (const e of events) {
      if (e.at.getTime() < now.getTime()) continue;  // upcoming only
      const wf = items[e.workflowId];
      if (!wf || wf.unsaved) continue;
      const f = e.at;
      const key = `${f.getFullYear()}-${f.getMonth()}-${f.getDate()}`;
      const arr = byDay.get(key) || [];
      arr.push({ wfId: wf.id, title: wf.title || 'Untitled', time: clockOf(f), sortKey: f.getTime(), steps: wf.steps.length, color: colorForWorkflow(wf) });
      byDay.set(key, arr);
    }
    const groups: ComingGroup[] = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(from.getTime() + i * 86400000);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const runs = (byDay.get(key) || []).sort((a, b) => a.sortKey - b.sortKey);
      if (runs.length) groups.push({ key, dayNum: d.getDate(), dow: d.toLocaleDateString([], { weekday: 'short' }), runs, countLabel: runs.length === 1 ? '1 run' : `${runs.length} runs` });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, items]);

  const recents = useMemo(() => allRuns.slice(0, 8).map((r) => ({
    id: r.id,
    wfId: r.workflow_id,
    title: items[r.workflow_id]?.title || 'Workflow',
    status: r.status,
    summary: r.error || r.last_tool_label || (r.status === 'success' ? 'Completed' : r.status),
    when: r.started_at ? new Date(r.started_at) : null,
  })), [allRuns, items]);

  const missedVisible = missedExpanded ? missed : missed.slice(0, 3);
  const reRunAll = () => { if (missed.length) dispatch(runMissedRuns(missed.map((m) => m.id))); };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: WC.page }}>
      <div style={{ flex: 'none', padding: '22px 30px 14px', borderBottom: `1px solid rgba(${WC.inkRGB},0.06)` }}>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: WC.muted2 }}>{todayLabel}</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 30px 32px' }}>
        {ongoing.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
              <span style={{ fontFamily: "'Newsreader',serif", fontSize: 18, fontWeight: 500, color: WC.ink }}>Ongoing runs</span>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: WC.accent, animation: 'os-pulse 1.1s ease-in-out infinite' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ongoing.map((o) => (
                <div key={o.wfId} onClick={() => dispatch(openWorkflowMonitor({ workflowId: o.wfId }))} style={{ display: 'flex', alignItems: 'center', gap: 13, background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.10)`, borderRadius: WC.radius.md, padding: '11px 15px', cursor: 'pointer' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: o.color, flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <WorkflowTitle value={o.title} animate={animateOf(o.wfId)}>
                        {(t) => <span style={{ fontSize: 14, fontWeight: 600, color: WC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>}
                      </WorkflowTitle>
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: WC.muted2, flex: 'none' }}>{o.stepLabel}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 999, background: WC.inset, overflow: 'hidden', marginTop: 7 }}>
                      <div style={{ width: `${o.pct}%`, height: '100%', borderRadius: 999, background: o.color, transition: 'width .4s ease' }} />
                    </div>
                    <div style={{ fontSize: 11.5, color: WC.muted, marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.nowText}</div>
                  </div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: WC.ink3, flex: 'none' }}>{o.clock}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: WC.accent, fontSize: 12, fontWeight: 600, flex: 'none' }}>
                    <span>Watch</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 22 }}>
        {missed.length > 0 && (
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
              <span style={{ fontFamily: "'Newsreader',serif", fontSize: 18, fontWeight: 500, color: WC.ink }}>Missed</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: WC.danger, background: WC.dangerBg, padding: '2px 8px', borderRadius: 999 }}>{missed.length}</span>
              <div style={{ flex: 1 }} />
              <button onClick={reRunAll} style={{ background: 'transparent', border: `1px solid rgba(${WC.inkRGB},0.14)`, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, color: WC.ink3, cursor: 'pointer' }}>Re-run all</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...(missedExpanded ? { maxHeight: 306, overflowY: 'auto', paddingRight: 4 } : {}) }}>
              {missedVisible.map((m) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: WC.raised, border: '1px solid rgba(194,72,58,0.20)', borderRadius: WC.radius.md, padding: '10px 14px' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: WC.danger, flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <WorkflowTitle value={m.workflow_title} animate={animateOf(m.workflow_id)}>
                      {(t) => <div style={{ fontSize: 13.5, fontWeight: 600, color: WC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>}
                    </WorkflowTitle>
                    <div style={{ fontSize: 11.5, color: WC.muted, marginTop: 1 }}>Missed while the app was closed</div>
                  </div>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: WC.muted2, flex: 'none' }}>{whenText(new Date(m.scheduled_for), now)}</span>
                  <button onClick={() => dispatch(runMissedRuns([m.id]))} style={{ background: WC.ink, color: WC.paper, border: 'none', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Re-run</button>
                  <div onClick={() => dispatch(dismissMissedRuns([m.id]))} title="Dismiss" style={{ width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WC.faint, flex: 'none' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </div>
                </div>
              ))}
            </div>
            {missed.length > 3 && (
              <button onClick={() => setMissedExpanded((v) => !v)} style={{ marginTop: 10, background: 'transparent', border: 'none', color: WC.danger, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '4px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>{missedExpanded ? 'Show less' : `Show all ${missed.length} missed`}</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ transform: missedExpanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="M6 9l6 6 6-6" /></svg>
              </button>
            )}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 18, fontWeight: 500, color: WC.ink, marginBottom: 12 }}>Coming up</div>
          {comingGroups.length === 0 && (
            <div style={{ fontSize: 13, color: WC.muted }}>Nothing scheduled in the next 7 days.</div>
          )}
          <div style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'hidden', paddingRight: 6 }}>
          {comingGroups.map((g) => (
            <div key={g.key} style={{ display: 'flex', gap: 18, padding: '4px 0 16px' }}>
              <div style={{ width: 62, flex: 'none', textAlign: 'right', paddingTop: 2 }}>
                <div style={{ fontFamily: "'Newsreader',serif", fontSize: 26, fontWeight: 500, color: WC.ink, lineHeight: 1 }}>{g.dayNum}</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, letterSpacing: '0.04em', textTransform: 'uppercase', color: WC.muted2, marginTop: 4 }}>{g.dow}</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: WC.faint, marginTop: 3 }}>{g.countLabel}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(expandedDays.has(g.key) ? g.runs : g.runs.slice(0, COMING_CAP)).map((r, i) => (
                  <div key={`${r.wfId}-${i}`} onClick={() => nav.selectWorkflow(r.wfId)} style={{ display: 'flex', alignItems: 'center', gap: 13, background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.md, padding: '12px 15px', cursor: 'pointer' }}>
                    <div style={{ width: 3, height: 30, borderRadius: 3, background: r.color, flex: 'none' }} />
                    <WorkflowTitle value={r.title} animate={animateOf(r.wfId)}>
                      {(t) => <span style={{ fontSize: 14, fontWeight: 600, color: WC.ink, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>}
                    </WorkflowTitle>
                    <span style={{ fontSize: 12, color: WC.muted }}>{r.steps} steps</span>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: WC.ink3, minWidth: 74, textAlign: 'right' }}>{r.time}</span>
                  </div>
                ))}
                {g.runs.length > COMING_CAP && (
                  <button onClick={() => setExpandedDays((prev) => { const next = new Set(prev); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next; })} style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', color: WC.muted, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '3px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{expandedDays.has(g.key) ? 'Show less' : `${g.runs.length - COMING_CAP} more`}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ transform: expandedDays.has(g.key) ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                )}
              </div>
            </div>
          ))}
          </div>
        </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 18, fontWeight: 500, color: WC.ink, marginBottom: 12 }}>Recents</div>
          {recents.length === 0 && <div style={{ fontSize: 13, color: WC.muted }}>No runs yet.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {recents.map((r) => (
              <div key={r.id} onClick={() => nav.selectWorkflow(r.wfId)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '11px 4px', borderBottom: `1px solid rgba(${WC.inkRGB},0.05)`, cursor: 'pointer' }}>
                <div style={statusDot(r.status, WC)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <WorkflowTitle value={r.title} animate={animateOf(r.wfId)}>
                    {(t) => <div style={{ fontSize: 13.5, fontWeight: 600, color: WC.ink }}>{t}</div>}
                  </WorkflowTitle>
                  <div style={{ fontSize: 12, color: WC.muted, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.summary}</div>
                </div>
                <div style={{ width: 72, display: 'flex', justifyContent: 'flex-end', flex: 'none' }}>
                  <span style={statusChip(r.status, WC)}>{r.status === 'failure' ? 'Failed' : r.status === 'success' ? 'Success' : r.status}</span>
                </div>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: WC.muted2, minWidth: 96, textAlign: 'right' }}>{whenText(r.when, now)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomeView;
