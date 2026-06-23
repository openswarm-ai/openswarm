import React, { useState, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { Workflow, ScheduleConfig } from '@/shared/state/workflowsSlice';
import { describeSchedule, needsScheduleTestWarning } from '@/app/pages/Workflows/scheduleUtils';
import { useWC, FONT_SERIF, track, knob } from './uiKit';
import {
  freqOf, patchForFreq, intervalMinutes, timeInputValue, parseTimeInput, ordinal, nextRunText, type Freq,
} from './model';
import { useWorkflowPatch } from './useWorkflowPatch';
import RepeatField from './RepeatField';

const FREQS: Array<[Freq, string]> = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['interval', 'Interval']];
const DAY_LABELS: Array<[string, number]> = [['S', 0], ['M', 1], ['T', 2], ['W', 3], ['T', 4], ['F', 5], ['S', 6]];

const ScheduleCard: React.FC<{ workflow: Workflow }> = ({ workflow }) => {
  const WC = useWC();
  const patch = useWorkflowPatch();
  const sched = workflow.schedule;
  const freq = freqOf(sched);
  const enabled = sched.enabled;

  const patchSched = (p: Partial<ScheduleConfig>) => patch(workflow, { schedule: { ...sched, ...p } });

  // The "Run at" field is an uncontrolled native time input so React doesn't
  // reset the segment's pending-digit state between keystrokes (a controlled
  // value made typing 4 then 5 land 05 instead of 45). To still reflect edits
  // from elsewhere (e.g. the agent reschedules), push the store time in
  // imperatively, and only when it actually differs from what's shown.
  const timeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = timeRef.current;
    if (!el) return;
    const want = timeInputValue(sched);
    if (el.value !== want) el.value = want;
  }, [sched.hour, sched.minute]);

  // Turning a weekly schedule on with no days picked is "unconfigured", so the
  // backend silently forces it back off and the switch looks dead. Seed today's
  // weekday so the default Weekly 9am toggles on (and stays on) in one click.
  const toggleEnabled = () => {
    if (!enabled && sched.repeat_unit === 'week' && sched.on_days.length === 0) {
      patchSched({ enabled: true, on_days: [new Date().getDay()] });
    } else {
      patchSched({ enabled: !enabled });
    }
  };

  // Local draft so the interval field can be cleared / mid-typed below the
  // floor without snapping; we warn instead and commit a valid value.
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);

  const freqBtn = (active: boolean): CSSProperties => ({
    flex: 1, padding: '6px 2px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
    background: active ? WC.paper : 'transparent', color: active ? WC.ink : WC.muted,
    boxShadow: active ? WC.shadow.sm : 'none',
  });
  const pillBtn = (active: boolean): CSSProperties => ({
    flex: 1, height: 30, borderRadius: 7, border: `1px solid ${active ? WC.accent : `rgba(${WC.inkRGB},0.12)`}`,
    cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: active ? WC.accent : WC.raised, color: active ? '#fff' : WC.muted,
  });

  const toggleDay = (d: number) => {
    const on = sched.on_days.includes(d);
    const next = on ? sched.on_days.filter((x) => x !== d) : [...sched.on_days, d];
    patchSched({ on_days: next.sort((a, b) => a - b) });
  };

  const intervalMins = intervalMinutes(sched);
  const intervalUnit: 'min' | 'hour' = sched.repeat_unit === 'hour' ? 'hour' : 'min';
  const intervalValue = intervalUnit === 'hour' ? Math.max(1, Math.round(intervalMins / 60)) : intervalMins;
  const minInterval = intervalUnit === 'hour' ? 1 : 15;
  const shownInterval = intervalDraft ?? String(intervalValue);
  const intervalWarn = intervalDraft != null && /^\d+$/.test(intervalDraft) && parseInt(intervalDraft, 10) < minInterval;
  const dom = sched.day_of_month ?? 1;
  const lastDay = !!sched.last_day_of_month;
  const stepBtn: CSSProperties = { width: 26, height: 26, background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 7, color: WC.ink3, fontSize: 15, cursor: lastDay ? 'default' : 'pointer', opacity: lastDay ? 0.4 : 1 };

  const maxRuns = sched.max_runs;
  // Picking a finite limit resets the lifetime counter so "run 3 times" always means 3 from now.
  const setMaxRuns = (n: number | null) => patchSched(n == null ? { max_runs: null } : { max_runs: n, runs_count: 0 });

  // A scheduled workflow with no steps fires but does nothing, so flag it.
  // Mirror the test-warning's draft-or-live read so the banner tracks edits.
  const hasNoSteps = !(workflow.draft_steps ?? workflow.steps ?? []).some((s) => s.text && s.text.trim());

  return (
    <div style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.lg, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink }}>Schedule</span>
        <div onClick={toggleEnabled} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: enabled ? WC.accent : WC.muted }}>{enabled ? 'On' : 'Off'}</span>
          <div style={track(enabled, WC)}><div style={knob(enabled)} /></div>
        </div>
      </div>

      {enabled && hasNoSteps && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12, padding: '9px 11px', background: `${WC.warn}14`, border: `1px solid ${WC.warn}40`, borderRadius: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={WC.warn} strokeWidth="1.9" style={{ flex: 'none', marginTop: 1 }}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <span style={{ fontSize: 12, color: WC.ink3, lineHeight: 1.45 }}>This workflow has no steps, so a scheduled run won&apos;t do anything. Add a step first.</span>
        </div>
      )}

      {enabled && !hasNoSteps && needsScheduleTestWarning(workflow) && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12, padding: '9px 11px', background: `${WC.warn}14`, border: `1px solid ${WC.warn}40`, borderRadius: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={WC.warn} strokeWidth="1.9" style={{ flex: 'none', marginTop: 1 }}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <span style={{ fontSize: 12, color: WC.ink3, lineHeight: 1.45 }}>Not test-run yet. A scheduled run can&apos;t pause for permission prompts, so if this needs tool access it may fail silently. Hit <b>Run</b> once to grant access.</span>
        </div>
      )}

      <div style={{ display: 'flex', background: WC.inset, border: `1px solid ${WC.line}`, borderRadius: 9, padding: 3, gap: 2, marginBottom: 12 }}>
        {FREQS.map(([k, label]) => (
          <button key={k} onClick={() => patchSched(patchForFreq(sched, k))} style={freqBtn(freq === k)}>{label}</button>
        ))}
      </div>

      {freq === 'weekly' && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
          {DAY_LABELS.map(([label, d], i) => (
            <button key={i} onClick={() => toggleDay(d)} style={pillBtn(sched.on_days.includes(d))}>{label}</button>
          ))}
        </div>
      )}

      {freq === 'monthly' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: WC.ink3 }}>Day of month</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => { if (!lastDay) patchSched({ day_of_month: dom <= 1 ? 31 : dom - 1 }); }} style={stepBtn}>−</button>
              <span style={{ minWidth: 62, textAlign: 'center', fontFamily: "'JetBrains Mono',monospace", fontWeight: 500, fontSize: 13, color: WC.ink }}>{lastDay ? 'Last day' : ordinal(dom)}</span>
              <button onClick={() => { if (!lastDay) patchSched({ day_of_month: dom >= 31 ? 1 : dom + 1 }); }} style={stepBtn}>+</button>
              <button onClick={() => patchSched({ last_day_of_month: !lastDay })} style={{ height: 26, padding: '0 10px', borderRadius: 7, border: `1px solid ${lastDay ? WC.accent : `rgba(${WC.inkRGB},0.12)`}`, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: lastDay ? WC.accent : WC.raised, color: lastDay ? '#fff' : WC.muted, flex: 'none' }}>Last</button>
            </div>
          </div>
          {!lastDay && dom >= 29 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={WC.warn} strokeWidth="1.9" style={{ flex: 'none' }}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
              <span style={{ fontSize: 11.5, color: WC.muted }}>Short months fire on their last day. Pick "Last" to always hit month-end.</span>
            </div>
          )}
        </>
      )}

      {freq !== 'interval' ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 13, color: WC.ink3 }}>Run at</span>
          <input
            type="time"
            ref={timeRef}
            defaultValue={timeInputValue(sched)}
            onChange={(e) => { const t = parseTimeInput(e.target.value); if (t) patchSched(t); }}
            style={{ width: 134, boxSizing: 'border-box', height: 32, background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 8, padding: '0 9px', fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: WC.ink }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 13, color: WC.ink3 }}>Run every</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text" inputMode="numeric" value={shownInterval}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                setIntervalDraft(raw);
                const v = parseInt(raw, 10);
                if (raw !== '' && v >= minInterval) patchSched({ repeat_every: v });
              }}
              onBlur={() => {
                const v = parseInt(intervalDraft ?? '', 10);
                if (intervalDraft != null && (intervalDraft === '' || Number.isNaN(v) || v < minInterval)) {
                  patchSched({ repeat_every: minInterval });
                }
                setIntervalDraft(null);
              }}
              style={{ width: 56, background: WC.raised, border: `1px solid ${intervalWarn ? WC.warn : `rgba(${WC.inkRGB},0.12)`}`, borderRadius: 8, padding: '6px 9px', fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: WC.ink, textAlign: 'right' }}
            />
            <select
              value={intervalUnit}
              onChange={(e) => {
                setIntervalDraft(null);
                if (e.target.value === 'hour') patchSched({ repeat_unit: 'hour', repeat_every: Math.max(1, Math.round(intervalMins / 60)) });
                else patchSched({ repeat_unit: 'minute', repeat_every: Math.max(15, intervalMins) });
              }}
              style={{ background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 8, padding: '6px 8px', fontSize: 13, color: WC.ink, cursor: 'pointer' }}
            >
              <option value="min">minutes</option>
              <option value="hour">hours</option>
            </select>
          </div>
        </div>
      )}

      {freq === 'interval' && intervalWarn && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, justifyContent: 'flex-end' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={WC.warn} strokeWidth="2" style={{ flex: 'none' }}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <span style={{ fontSize: 11.5, color: WC.warn }}>Minimum is {minInterval} {intervalUnit === 'hour' ? 'hour' : 'minutes'}.</span>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 13, color: WC.ink3 }}>Repeat</span>
        <RepeatField value={maxRuns} onChange={setMaxRuns} />
      </div>

      <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${WC.line}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={WC.muted} strokeWidth="1.8" style={{ flex: 'none' }}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span style={{ fontSize: 12.5, color: WC.ink4 }}>{describeSchedule(sched)}</span>
      </div>
      <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: WC.accent }} /></div>
        <span style={{ fontSize: 12.5, color: WC.ink4 }}>Next run {nextRunText(workflow, workflow.next_run_at ? new Date(workflow.next_run_at) : null)}</span>
      </div>
      {maxRuns != null && (
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: WC.muted }} /></div>
          <span style={{ fontSize: 12.5, color: WC.ink4 }}>{sched.runs_count} of {maxRuns} run{maxRuns === 1 ? '' : 's'} done</span>
        </div>
      )}
    </div>
  );
};

export default ScheduleCard;
