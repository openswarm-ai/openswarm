// "When something happens" panel beside the Schedule card: watch a folder/file
// or a web page, optionally filter with a plain-English condition, and see the
// trigger's recent activity ("saw X, skipped because Y") so a quiet trigger is
// debuggable instead of mysterious.

import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { API_BASE } from '@/shared/config';
import type { EventTriggerConfig, Workflow, WorkflowEventLogEntry } from '@/shared/state/workflowsSlice';
import { useWC, FONT_SERIF, track, knob } from './uiKit';
import { useWorkflowPatch } from './useWorkflowPatch';

const WEB_POLL_CHOICES: Array<[number, string]> = [[60, 'every minute'], [300, 'every 5 min'], [900, 'every 15 min'], [3600, 'hourly']];

function newTrigger(kind: 'file' | 'web'): EventTriggerConfig {
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    enabled: true,
    source: kind === 'file'
      ? { kind: 'file', path: '', poll_seconds: 15 }
      : { kind: 'web', url: '', watch_for: '', poll_seconds: 300 },
    predicate: '',
    coalesce_seconds: kind === 'file' ? 30 : 0,
    max_fires_per_hour: 6,
  };
}

const EventTriggersCard: React.FC<{ workflow: Workflow }> = ({ workflow }) => {
  const WC = useWC();
  const patch = useWorkflowPatch();
  const triggers = workflow.event_triggers ?? [];
  const [log, setLog] = useState<WorkflowEventLogEntry[]>([]);

  const patchTriggers = useCallback((next: EventTriggerConfig[]) => {
    patch(workflow, { event_triggers: next });
  }, [patch, workflow]);

  const updateTrigger = useCallback((id: string, mut: (t: EventTriggerConfig) => EventTriggerConfig) => {
    patchTriggers(triggers.map((t) => (t.id === id ? mut(t) : t)));
  }, [patchTriggers, triggers]);

  // Activity poll while the panel is mounted; local endpoint, cheap.
  useEffect(() => {
    if (triggers.length === 0) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API_BASE}/workflows/${workflow.id}/events`);
        const data = (await r.json()) as { events: WorkflowEventLogEntry[] };
        if (alive) setLog(data.events ?? []);
      } catch { /* activity is best-effort */ }
    };
    void load();
    const iv = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [workflow.id, triggers.length]);

  const ghostBtn: CSSProperties = {
    height: 26, padding: '0 10px', borderRadius: 7, border: `1px solid rgba(${WC.inkRGB},0.12)`,
    cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: WC.raised, color: WC.ink3,
  };
  const fieldStyle: CSSProperties = {
    width: '100%', boxSizing: 'border-box', height: 30, background: WC.raised,
    border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 8, padding: '0 9px',
    fontSize: 12.5, color: WC.ink,
  };
  const labelStyle: CSSProperties = { fontSize: 11.5, color: WC.muted, marginBottom: 4, display: 'block' };

  const dotColor = (kind: WorkflowEventLogEntry['kind']): string => {
    if (kind === 'fired') return WC.accent;
    if (kind === 'emitted') return WC.muted;
    return WC.warn;
  };

  return (
    <div style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.lg, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink }}>Event triggers</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={ghostBtn} onClick={() => patchTriggers([...triggers, newTrigger('file')])}>+ Folder</button>
          <button style={ghostBtn} onClick={() => patchTriggers([...triggers, newTrigger('web')])}>+ Web page</button>
        </div>
      </div>

      {triggers.length === 0 && (
        <span style={{ fontSize: 12.5, color: WC.ink4, lineHeight: 1.5, display: 'block' }}>
          Run this workflow when something happens: a file lands in a folder, or a page you care about changes.
        </span>
      )}

      {triggers.map((t) => {
        const src = t.source;
        return (
        <div key={t.id} style={{ border: `1px solid ${WC.line}`, borderRadius: 10, padding: '10px 11px', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: WC.ink3 }}>
              {src.kind === 'file' ? 'Folder / file watch' : 'Web page watch'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                onClick={() => updateTrigger(t.id, (x) => ({ ...x, enabled: !x.enabled }))}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 600, color: t.enabled ? WC.accent : WC.muted }}>{t.enabled ? 'On' : 'Off'}</span>
                <div style={track(t.enabled, WC)}><div style={knob(t.enabled)} /></div>
              </div>
              <button
                aria-label="Remove trigger"
                onClick={() => patchTriggers(triggers.filter((x) => x.id !== t.id))}
                style={{ ...ghostBtn, padding: '0 8px' }}
              >
                ✕
              </button>
            </div>
          </div>

          {src.kind === 'file' ? (
            <div style={{ marginBottom: 8 }}>
              <span style={labelStyle}>Watch this folder or file</span>
              <input
                style={fieldStyle}
                defaultValue={src.path}
                placeholder="~/Downloads"
                onBlur={(e) => {
                  const path = e.target.value.trim();
                  if (path !== src.path) updateTrigger(t.id, (x) => ({ ...x, source: { ...src, path } }));
                }}
              />
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <span style={labelStyle}>Page URL</span>
                <input
                  style={fieldStyle}
                  defaultValue={src.url}
                  placeholder="https://example.com/reservations"
                  onBlur={(e) => {
                    const url = e.target.value.trim();
                    if (url !== src.url) updateTrigger(t.id, (x) => ({ ...x, source: { ...src, url } }));
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>Watching for</span>
                  <input
                    style={fieldStyle}
                    defaultValue={src.watch_for}
                    placeholder="a reservation slot opening"
                    onBlur={(e) => {
                      const watchFor = e.target.value.trim();
                      if (watchFor !== src.watch_for) updateTrigger(t.id, (x) => ({ ...x, source: { ...src, watch_for: watchFor } }));
                    }}
                  />
                </div>
                <div style={{ width: 118, flex: 'none' }}>
                  <span style={labelStyle}>Check</span>
                  <select
                    value={src.poll_seconds}
                    onChange={(e) => {
                      const pollSeconds = parseInt(e.target.value, 10);
                      updateTrigger(t.id, (x) => ({ ...x, source: { ...src, poll_seconds: pollSeconds } }));
                    }}
                    style={{ ...fieldStyle, cursor: 'pointer', padding: '0 6px' }}
                  >
                    {WEB_POLL_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}

          <div>
            <span style={labelStyle}>Only when (optional, plain English)</span>
            <input
              style={fieldStyle}
              defaultValue={t.predicate}
              placeholder={src.kind === 'file' ? 'a new CSV export shows up' : 'the change mentions Friday or Saturday'}
              onBlur={(e) => {
                const predicate = e.target.value.trim();
                if (predicate !== t.predicate) updateTrigger(t.id, (x) => ({ ...x, predicate }));
              }}
            />
          </div>
        </div>
        );
      })}

      {triggers.length > 0 && log.length > 0 && (
        <div style={{ marginTop: 4, paddingTop: 11, borderTop: `1px solid ${WC.line}` }}>
          <span style={{ ...labelStyle, marginBottom: 7 }}>Recent activity</span>
          {log.slice(0, 6).map((e, i) => (
            <div key={`${e.ts}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
              <div style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none', paddingTop: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor(e.kind) }} />
              </div>
              <span style={{ fontSize: 11.5, color: WC.ink4, lineHeight: 1.45 }}>
                {new Date(e.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {' '}
                {e.summary}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default EventTriggersCard;
