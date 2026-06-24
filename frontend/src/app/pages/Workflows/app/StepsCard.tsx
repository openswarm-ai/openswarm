import React, { useEffect, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { commitDraft } from '@/shared/state/workflowsSlice';
import type { Workflow, WorkflowStep } from '@/shared/state/workflowsSlice';
import { stepsSignature } from '@/app/pages/Workflows/scheduleUtils';
import { useWC, FONT_SERIF, FONT_SANS, track, knob } from './uiKit';
import { useWorkflowPatch } from './useWorkflowPatch';

interface LocalStep { id: string; label: string; text: string; open: boolean; enabled: boolean; }

function toLocal(steps: WorkflowStep[]): LocalStep[] {
  return steps.map((s) => ({ id: s.id, label: s.label || s.text.slice(0, 48), text: s.text, open: false, enabled: s.enabled !== false }));
}
function newStepId(): string {
  return `step-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const StepsCard: React.FC<{ workflow: Workflow }> = ({ workflow }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const patch = useWorkflowPatch();
  const [local, setLocal] = useState<LocalStep[]>(() => toLocal(workflow.steps));
  const [draft, setDraft] = useState('');

  // Agent-proposed step changes apply silently (no Apply/Discard popup): commit
  // any staged draft as soon as it lands so the steps just update live. Guarded
  // on real content, the edit session snapshots an empty draft on open and
  // committing that 400s.
  useEffect(() => {
    if (workflow.has_draft && (workflow.draft_steps || []).some((s) => s.text && s.text.trim())) {
      dispatch(commitDraft({ id: workflow.id, keep_session: true }));
    }
  }, [workflow.has_draft, workflow.draft_steps, workflow.id, dispatch]);

  const sig = stepsSignature(workflow.steps);
  // Reseed when the server steps change underneath us (commit, agent edit,
  // another surface) but not on our own in-progress keystrokes.
  useEffect(() => {
    setLocal((prev) => {
      const openIds = new Set(prev.filter((s) => s.open).map((s) => s.id));
      return toLocal(workflow.steps).map((s) => ({ ...s, open: openIds.has(s.id) }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // A manual add lands with an empty label that the backend names from the step
  // text. The label arrives without changing the steps signature (same text), so
  // fill it in here without a full reseed and without touching a label you're
  // mid-typing.
  useEffect(() => {
    setLocal((prev) => {
      const byId = new Map(workflow.steps.map((s) => [s.id, s]));
      let changed = false;
      const next = prev.map((s) => {
        const srv = byId.get(s.id);
        if (srv && !s.label.trim() && (srv.label || '').trim()) {
          changed = true;
          return { ...s, label: srv.label as string };
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [workflow.steps]);

  const commit = (next: LocalStep[]) => {
    patch(workflow, { steps: next.map((s) => ({ id: s.id, text: s.text, label: s.label, enabled: s.enabled })) });
  };

  const update = (id: string, p: Partial<LocalStep>) => setLocal((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const toggleEnabled = (id: string) => {
    const next = local.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
    setLocal(next);
    commit(next);
  };
  const onAdd = () => {
    const t = draft.trim();
    if (!t) return;
    // What you type is the step's prompt; the short label is generated from it
    // server-side (empty label tells the backend to name this step).
    const next = [...local, { id: newStepId(), label: '', text: t, open: false, enabled: true }];
    setLocal(next);
    setDraft('');
    commit(next);
  };
  const onDelete = (id: string) => {
    const next = local.filter((s) => s.id !== id);
    setLocal(next);
    commit(next);
  };

  return (
    <div style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.lg, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink }}>Steps</span>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: WC.muted2 }}>{local.length} step{local.length === 1 ? '' : 's'}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {local.map((s, i) => (
          <div key={s.id} style={{ border: `1px solid ${s.open ? `rgba(${WC.inkRGB},0.16)` : `rgba(${WC.inkRGB},0.10)`}`, borderRadius: WC.radius.md, background: s.open ? WC.raised : WC.paper, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 9px 9px 11px', opacity: s.enabled ? 1 : 0.5 }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: WC.faint, width: 13, flex: 'none' }}>{i + 1}</span>
              <input
                value={s.label}
                onChange={(e) => update(s.id, { label: e.target.value })}
                onBlur={() => commit(local)}
                placeholder="Step title"
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: 0, fontSize: 13, fontWeight: 600, color: WC.ink, textDecoration: s.enabled ? 'none' : 'line-through' }}
              />
              <div onClick={() => toggleEnabled(s.id)} title={s.enabled ? 'Disable step' : 'Enable step'} style={{ ...track(s.enabled, WC), transform: 'scale(0.82)' }}><div style={knob(s.enabled)} /></div>
              <div onClick={() => update(s.id, { open: !s.open })} style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WC.muted, flex: 'none' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ transform: s.open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="M6 9l6 6 6-6" /></svg>
              </div>
              <div onClick={() => onDelete(s.id)} style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WC.faint, flex: 'none' }} aria-label="Delete step">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
              </div>
            </div>
            {!s.open && s.text.trim() && s.text.trim() !== s.label.trim() && (
              <div style={{ padding: '0 11px 10px 34px', fontSize: 12, color: WC.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.text}</div>
            )}
            {s.open && (
              <div style={{ padding: '0 11px 12px 34px' }}>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: WC.muted2, marginBottom: 6 }}>Prompt</div>
                <textarea
                  value={s.text}
                  onChange={(e) => update(s.id, { text: e.target.value })}
                  onBlur={() => commit(local)}
                  placeholder="What should this step do?"
                  style={{ width: '100%', boxSizing: 'border-box', border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 8, background: WC.paper, padding: '9px 11px', fontSize: 12.5, lineHeight: 1.5, color: WC.ink2, resize: 'vertical', minHeight: 76, fontFamily: FONT_SANS }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 7, marginTop: 11 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
          placeholder="Add a step…"
          style={{ flex: 1, background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.12)`, borderRadius: 8, padding: '8px 11px', fontSize: 13, color: WC.ink }}
        />
        <button onClick={onAdd} style={{ background: WC.ink, color: WC.paper, border: 'none', borderRadius: 8, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
    </div>
  );
};

export default StepsCard;
