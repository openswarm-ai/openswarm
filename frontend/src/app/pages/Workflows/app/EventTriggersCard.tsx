// "When something happens" panel beside the Schedule card. Four source kinds
// cover the universe: folder/file watch, web page watch, agent check (any
// natural-language condition), and custom push (anything can POST an event).
// The Recent-activity feed makes a quiet trigger debuggable instead of
// mysterious ("saw X, skipped because Y").

import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { API_BASE } from '@/shared/config';
import type { EventSourceConfig, EventTriggerConfig, Workflow, WorkflowEventLogEntry } from '@/shared/state/workflowsSlice';
import EventTriggerRow from './EventTriggerRow';
import { useWC, FONT_SERIF } from './uiKit';
import { useWorkflowPatch } from './useWorkflowPatch';

type TriggerKind = 'file' | 'web' | 'agent' | 'custom';

const ADD_CHOICES: Array<[TriggerKind, string]> = [
  ['file', '+ Folder'],
  ['web', '+ Page'],
  ['agent', '+ Agent check'],
  ['custom', '+ Custom'],
];

function newSource(kind: TriggerKind): EventSourceConfig {
  if (kind === 'file') return { kind: 'file', path: '', poll_seconds: 15 };
  if (kind === 'web') return { kind: 'web', url: '', watch_for: '', poll_seconds: 300 };
  if (kind === 'agent') return { kind: 'agent', check: '', model: '', poll_seconds: 900 };
  return { kind: 'custom' };
}

function newTrigger(kind: TriggerKind): EventTriggerConfig {
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    enabled: true,
    source: newSource(kind),
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
    height: 26, padding: '0 8px', borderRadius: 7, border: `1px solid rgba(${WC.inkRGB},0.12)`,
    cursor: 'pointer', fontSize: 11, fontWeight: 600, background: WC.raised, color: WC.ink3, whiteSpace: 'nowrap',
  };
  const labelStyle: CSSProperties = { fontSize: 11.5, color: WC.muted, marginBottom: 7, display: 'block' };

  const dotColor = (kind: WorkflowEventLogEntry['kind']): string => {
    if (kind === 'fired') return WC.accent;
    if (kind === 'emitted') return WC.muted;
    return WC.warn;
  };

  return (
    <div style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.lg, padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink, display: 'block', marginBottom: 8 }}>Event triggers</span>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {ADD_CHOICES.map(([kind, label]) => (
            <button key={kind} style={ghostBtn} onClick={() => patchTriggers([...triggers, newTrigger(kind)])}>{label}</button>
          ))}
        </div>
      </div>

      {triggers.length === 0 && (
        <span style={{ fontSize: 12.5, color: WC.ink4, lineHeight: 1.5, display: 'block' }}>
          Run this workflow when something happens: a file lands, a page changes, an agent spots any condition you describe, or anything pushes an event in.
        </span>
      )}

      {triggers.map((t) => (
        <EventTriggerRow
          key={t.id}
          workflow={workflow}
          trigger={t}
          onMutate={(mut) => patchTriggers(triggers.map((x) => (x.id === t.id ? mut(x) : x)))}
          onRemove={() => patchTriggers(triggers.filter((x) => x.id !== t.id))}
        />
      ))}

      {triggers.length > 0 && log.length > 0 && (
        <div style={{ marginTop: 4, paddingTop: 11, borderTop: `1px solid ${WC.line}` }}>
          <span style={labelStyle}>Recent activity</span>
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
