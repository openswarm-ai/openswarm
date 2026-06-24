import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { deleteWorkflow } from '@/shared/state/workflowsSlice';
import { isScheduleActive, describeSchedule } from '@/app/pages/Workflows/scheduleUtils';
import { colorForWorkflow, useWC } from './uiKit';
import WorkflowTitle from './WorkflowTitle';
import type { AppNav } from './types';

const navBase: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, padding: '6px 9px',
  borderRadius: 8, cursor: 'pointer', fontSize: 13.5,
};

const LeftRail: React.FC<{ nav: AppNav }> = ({ nav }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.workflows.items);
  const trashCount = useAppSelector((s) => s.workflows.deleted.length);
  const [query, setQuery] = useState('');

  const workflows = useMemo(() => Object.values(items)
    .filter((w) => !w.unsaved)
    .sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at)), [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter((w) => w.title.toLowerCase().includes(q));
  }, [workflows, query]);

  const activeCount = workflows.filter((w) => isScheduleActive(w.schedule)).length;

  const onDelete = (id: string) => {
    // Soft-delete: moves to Trash (recoverable), so no scary confirm.
    dispatch(deleteWorkflow(id));
    if (nav.selectedId === id) nav.goHome();
  };

  const homeStyle: CSSProperties = nav.mode === 'home'
    ? { ...navBase, background: WC.selBg, color: WC.ink, fontWeight: 600 }
    : { ...navBase, color: WC.ink3 };
  const calStyle: CSSProperties = nav.mode === 'calendar'
    ? { ...navBase, background: WC.selBg, color: WC.ink, fontWeight: 600 }
    : { ...navBase, color: WC.ink3 };
  const newStyle: CSSProperties = nav.mode === 'new'
    ? { ...navBase, background: WC.accent, color: '#fff', fontWeight: 600 }
    : { ...navBase, color: WC.accent, fontWeight: 600 };
  const trashStyle: CSSProperties = nav.mode === 'trash'
    ? { ...navBase, background: WC.selBg, color: WC.ink, fontWeight: 600 }
    : { ...navBase, color: WC.ink3 };

  return (
    <div style={{ width: 248, flex: 'none', borderRight: `1px solid ${WC.line}`, background: WC.rail, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 12px 10px', flex: 'none' }}>
        <div style={{ height: 30, borderRadius: 8, background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px', color: WC.muted, fontSize: 12.5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12.5, color: WC.ink }}
          />
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, opacity: 0.6 }}>⌘K</span>
        </div>
      </div>

      <div style={{ padding: '4px 8px', flex: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div onClick={nav.goHome} style={homeStyle}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M3 11l9-7 9 7M5 10v9h5v-6h4v6h5v-9" /></svg>
          <span>Home</span>
        </div>
        <div onClick={nav.goCalendar} style={calStyle}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></svg>
          <span>Calendar</span>
        </div>
        <div onClick={nav.goNew} style={newStyle}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
          <span>New Workflow</span>
        </div>
      </div>

      <div style={{ padding: '14px 16px 6px', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: WC.muted2 }}>Workflows</span>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: WC.muted2 }}>{activeCount}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px', minHeight: 0 }}>
        {filtered.map((w) => {
          const active = isScheduleActive(w.schedule);
          const isSel = nav.mode === 'detail' && w.id === nav.selectedId;
          return (
            <div
              key={w.id}
              onClick={() => nav.selectWorkflow(w.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 9px', borderRadius: 8, cursor: 'pointer', background: isSel ? WC.selBg : 'transparent' }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: colorForWorkflow(w), opacity: active ? 1 : 0.35 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <WorkflowTitle value={w.title} animate={w.auto_named !== false}>
                  {(t) => <div style={{ fontSize: 13.5, fontWeight: 600, color: active ? WC.ink : WC.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>}
                </WorkflowTitle>
                <div style={{ fontSize: 11, color: WC.muted2, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {active ? describeSchedule(w.schedule) : 'Paused'}
                </div>
              </div>
              <div
                onClick={(e) => { e.stopPropagation(); onDelete(w.id); }}
                style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WC.faint, flex: 'none' }}
                aria-label="Move to trash"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: '18px 10px', fontSize: 12.5, color: WC.muted2 }}>No workflows yet.</div>
        )}
      </div>

      <div style={{ flex: 'none', borderTop: `1px solid ${WC.line}`, padding: '8px' }}>
        <div onClick={nav.goTrash} style={trashStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
          <span>Trash</span>
          {trashCount > 0 && (
            <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: WC.muted2 }}>{trashCount}</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default LeftRail;
