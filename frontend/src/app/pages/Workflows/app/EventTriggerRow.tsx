// One trigger row inside the Event Triggers panel: folder watch, page watch,
// agent check (any natural-language condition), or custom push (ingest API).
// Text fields commit onBlur so typing doesn't PATCH per keystroke.

import React from 'react';
import type { CSSProperties } from 'react';
import { API_BASE } from '@/shared/config';
import type { EventTriggerConfig, Workflow } from '@/shared/state/workflowsSlice';
import { useWC, track, knob } from './uiKit';

const KIND_LABELS: Record<string, string> = {
  file: 'Folder / file watch',
  web: 'Web page watch',
  agent: 'Agent check',
  custom: 'Custom (push)',
  stream: 'Live feed (SSE)',
};

interface RowProps {
  workflow: Workflow;
  trigger: EventTriggerConfig;
  onMutate: (mut: (t: EventTriggerConfig) => EventTriggerConfig) => void;
  onRemove: () => void;
}

const EventTriggerRow: React.FC<RowProps> = ({ workflow, trigger, onMutate, onRemove }) => {
  const WC = useWC();
  const t = trigger;
  const src = t.source;

  const fieldStyle: CSSProperties = {
    width: '100%', boxSizing: 'border-box', height: 30, background: WC.raised,
    border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 8, padding: '0 9px',
    fontSize: 12.5, color: WC.ink,
  };
  const labelStyle: CSSProperties = { fontSize: 11.5, color: WC.muted, marginBottom: 4, display: 'block' };
  const ghostBtn: CSSProperties = {
    height: 26, padding: '0 8px', borderRadius: 7, border: `1px solid rgba(${WC.inkRGB},0.12)`,
    cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: WC.raised, color: WC.ink3,
  };

  return (
    <div style={{ border: `1px solid ${WC.line}`, borderRadius: 10, padding: '10px 11px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: WC.ink3 }}>{KIND_LABELS[src.kind] ?? src.kind}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            onClick={() => onMutate((x) => ({ ...x, enabled: !x.enabled }))}
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          >
            <span style={{ fontSize: 11.5, fontWeight: 600, color: t.enabled ? WC.accent : WC.muted }}>{t.enabled ? 'On' : 'Off'}</span>
            <div style={track(t.enabled, WC)}><div style={knob(t.enabled)} /></div>
          </div>
          <button aria-label="Remove trigger" onClick={onRemove} style={{ ...ghostBtn, padding: '0 8px' }}>✕</button>
        </div>
      </div>

      {src.kind === 'file' && (
        <div style={{ marginBottom: 8 }}>
          <span style={labelStyle}>Watch this folder or file</span>
          <input
            style={fieldStyle}
            defaultValue={src.path}
            placeholder="~/Downloads"
            onBlur={(e) => {
              const path = e.target.value.trim();
              if (path !== src.path) onMutate((x) => ({ ...x, source: { ...src, path } }));
            }}
          />
        </div>
      )}

      {src.kind === 'web' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <span style={labelStyle}>Page URL</span>
            <input
              style={fieldStyle}
              defaultValue={src.url}
              placeholder="https://example.com/reservations"
              onBlur={(e) => {
                const url = e.target.value.trim();
                if (url !== src.url) onMutate((x) => ({ ...x, source: { ...src, url } }));
              }}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={labelStyle}>Watching for (checked automatically; speeds up when things happen)</span>
            <input
              style={fieldStyle}
              defaultValue={src.watch_for}
              placeholder="a reservation slot opening"
              onBlur={(e) => {
                const watchFor = e.target.value.trim();
                if (watchFor !== src.watch_for) onMutate((x) => ({ ...x, source: { ...src, watch_for: watchFor } }));
              }}
            />
          </div>
        </>
      )}

      {src.kind === 'agent' && (
        <div style={{ marginBottom: 8 }}>
          <span style={labelStyle}>What counts as the event? An agent checks automatically with its tools.</span>
          <input
            style={fieldStyle}
            defaultValue={src.check}
            placeholder="a new episode of my favorite podcast is out"
            onBlur={(e) => {
              const check = e.target.value.trim();
              if (check !== src.check) onMutate((x) => ({ ...x, source: { ...src, check } }));
            }}
          />
        </div>
      )}

      {src.kind === 'stream' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Feed URL (Server-Sent Events)</span>
            <input
              style={fieldStyle}
              defaultValue={src.url}
              placeholder="https://stream.example.com/events"
              onBlur={(e) => {
                const url = e.target.value.trim();
                if (url !== src.url) onMutate((x) => ({ ...x, source: { ...src, url } }));
              }}
            />
          </div>
          <div style={{ width: 150, flex: 'none' }}>
            <span style={labelStyle}>Only lines containing</span>
            <input
              style={fieldStyle}
              defaultValue={src.contains}
              placeholder="(everything)"
              onBlur={(e) => {
                const contains = e.target.value.trim();
                if (contains !== src.contains) onMutate((x) => ({ ...x, source: { ...src, contains } }));
              }}
            />
          </div>
        </div>
      )}

      {src.kind === 'custom' && (
        <div style={{ marginBottom: 8 }}>
          <span style={labelStyle}>Anything can push events here (scripts, webhooks, Shortcuts):</span>
          <pre style={{
            margin: 0, padding: '8px 10px', background: WC.inset, border: `1px solid ${WC.line}`,
            borderRadius: 8, fontSize: 10.5, color: WC.ink3, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            fontFamily: "'JetBrains Mono',monospace", userSelect: 'text',
          }}>
            {src.secret
              ? `POST ${API_BASE}/events/ingest/${src.secret}\n{"summary": "what happened"}`
              : `POST ${API_BASE}/events/ingest\n{"workflow_id": "${workflow.id}", "trigger_id": "${t.id}", "summary": "what happened"}`}
          </pre>
        </div>
      )}

      <div>
        <span style={labelStyle}>Only when (optional, plain English)</span>
        <input
          style={fieldStyle}
          defaultValue={t.predicate}
          placeholder={src.kind === 'file' ? 'a new CSV export shows up' : 'it matters enough to act on'}
          onBlur={(e) => {
            const predicate = e.target.value.trim();
            if (predicate !== t.predicate) onMutate((x) => ({ ...x, predicate }));
          }}
        />
      </div>
    </div>
  );
};

export default EventTriggerRow;
