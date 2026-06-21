import React from 'react';
import type { CSSProperties } from 'react';
import type { Workflow, ScheduleConfig } from '@/shared/state/workflowsSlice';
import { describeSchedule } from '@/app/pages/Workflows/scheduleUtils';
import { WC, FONT_SERIF, track, knob } from './uiKit';
import {
  freqOf, patchForFreq, intervalMinutes, timeInputValue, parseTimeInput, ordinal, nextRunText, type Freq,
} from './model';
import { useWorkflowPatch } from './useWorkflowPatch';
import RepeatField from './RepeatField';

const FREQS: Array<[Freq, string]> = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['interval', 'Interval']];
const DAY_LABELS: Array<[string, number]> = [['S', 0], ['M', 1], ['T', 2], ['W', 3], ['T', 4], ['F', 5], ['S', 6]];

const ScheduleCard: React.FC<{ workflow: Workflow }> = ({ workflow }) => {
  const patch = useWorkflowPatch();
  const sched = workflow.schedule;
  const freq = freqOf(sched);
  const enabled = sched.enabled;

  const patchSched = (p: Partial<ScheduleConfig>) => patch(workflow, { schedule: { ...sched, ...p } });

  const freqBtn = (active: boolean): CSSProperties => ({
    flex: 1, padding: '6px 2px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
    background: active ? WC.paper : 'transparent', color: active ? WC.ink : WC.muted,
    boxShadow: active ? '0 1px 3px rgba(33,30,27,0.10)' : 'none',
  });
  const pillBtn = (active: boolean): CSSProperties => ({
    flex: 1, height: 30, borderRadius: 7, border: `1px solid ${active ? WC.accent : 'rgba(33,30,27,0.12)'}`,
    cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: active ? WC.accent : '#FFFFFF', color: active ? '#fff' : WC.muted,
  });

  const toggleDay = (d: number) => {
    const on = sched.on_days.includes(d);
    const next = on ? sched.on_days.filter((x) => x !== d) : [...sched.on_days, d];
    patchSched({ on_days: next.sort((a, b) => a - b) });
  };

  const intervalMins = intervalMinutes(sched);
  const intervalUnit: 'min' | 'hour' = sched.repeat_unit === 'hour' ? 'hour' : 'min';
  const intervalValue = intervalUnit === 'hour' ? Math.max(1, Math.round(intervalMins / 60)) : intervalMins;
  const dom = sched.day_of_month ?? 1;

  const maxRuns = sched.max_runs;
  // Picking a finite limit resets the lifetime counter so "run 3 times" always means 3 from now.
  const setMaxRuns = (n: number | null) => patchSched(n == null ? { max_runs: null } : { max_runs: n, runs_count: 0 });

  return (
    <div style={{ background: WC.paper, border: '1px solid rgba(33,30,27,0.08)', borderRadius: 13, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink }}>Schedule</span>
        <div onClick={() => patchSched({ enabled: !enabled })} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: enabled ? WC.accent : WC.muted }}>{enabled ? 'On' : 'Off'}</span>
          <div style={track(enabled)}><div style={knob(enabled)} /></div>
        </div>
      </div>

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: WC.ink3 }}>Day of month</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => patchSched({ day_of_month: dom <= 1 ? 31 : dom - 1 })} style={{ width: 26, height: 26, background: '#FFFFFF', border: '1px solid rgba(33,30,27,0.12)', borderRadius: 7, color: WC.ink3, fontSize: 15, cursor: 'pointer' }}>−</button>
            <span style={{ minWidth: 62, textAlign: 'center', fontFamily: "'JetBrains Mono',monospace", fontWeight: 500, fontSize: 13, color: WC.ink }}>{ordinal(dom)}</span>
            <button onClick={() => patchSched({ day_of_month: dom >= 31 ? 1 : dom + 1 })} style={{ width: 26, height: 26, background: '#FFFFFF', border: '1px solid rgba(33,30,27,0.12)', borderRadius: 7, color: WC.ink3, fontSize: 15, cursor: 'pointer' }}>+</button>
          </div>
        </div>
      )}

      {freq !== 'interval' ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 13, color: WC.ink3 }}>Run at</span>
          <input
            type="time"
            value={timeInputValue(sched)}
            onChange={(e) => { const t = parseTimeInput(e.target.value); if (t) patchSched(t); }}
            style={{ width: 134, boxSizing: 'border-box', height: 32, background: '#FFFFFF', border: '1px solid rgba(33,30,27,0.12)', borderRadius: 8, padding: '0 9px', fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: WC.ink }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 13, color: WC.ink3 }}>Run every</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="number" min={1} value={intervalValue}
              onChange={(e) => {
                const v = Math.max(1, parseInt(e.target.value, 10) || 1);
                patchSched({ repeat_every: intervalUnit === 'hour' ? v : Math.max(15, v) });
              }}
              style={{ width: 56, background: '#FFFFFF', border: '1px solid rgba(33,30,27,0.12)', borderRadius: 8, padding: '6px 9px', fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: WC.ink, textAlign: 'right' }}
            />
            <select
              value={intervalUnit}
              onChange={(e) => {
                if (e.target.value === 'hour') patchSched({ repeat_unit: 'hour', repeat_every: Math.max(1, Math.round(intervalMins / 60)) });
                else patchSched({ repeat_unit: 'minute', repeat_every: Math.max(15, intervalMins) });
              }}
              style={{ background: '#FFFFFF', border: '1px solid rgba(33,30,27,0.12)', borderRadius: 8, padding: '6px 8px', fontSize: 13, color: WC.ink, cursor: 'pointer' }}
            >
              <option value="min">minutes</option>
              <option value="hour">hours</option>
            </select>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 13, color: WC.ink3 }}>Repeat</span>
        <RepeatField value={maxRuns} onChange={setMaxRuns} />
      </div>

      <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${WC.line}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={WC.muted} strokeWidth="1.8" style={{ flex: 'none' }}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span style={{ fontSize: 12.5, color: '#6B655C' }}>{describeSchedule(sched)}</span>
      </div>
      <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: WC.accent }} /></div>
        <span style={{ fontSize: 12.5, color: '#6B655C' }}>Next run {nextRunText(workflow)}</span>
      </div>
      {maxRuns != null && (
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: WC.muted }} /></div>
          <span style={{ fontSize: 12.5, color: '#6B655C' }}>{sched.runs_count} of {maxRuns} run{maxRuns === 1 ? '' : 's'} done</span>
        </div>
      )}
    </div>
  );
};

export default ScheduleCard;
