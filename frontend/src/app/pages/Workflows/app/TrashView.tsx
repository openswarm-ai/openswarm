import React, { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchDeletedWorkflows, restoreWorkflow, purgeWorkflow } from '@/shared/state/workflowsSlice';
import { colorForWorkflow, useWC, FONT_SERIF } from './uiKit';
import { whenText } from './model';

const TrashView: React.FC = () => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const dashboardId = useAppSelector((s) => s.tempState.lastDashboardId) || undefined;
  const deleted = useAppSelector((s) => s.workflows.deleted);
  const loading = useAppSelector((s) => s.workflows.deletedLoading);

  useEffect(() => { dispatch(fetchDeletedWorkflows(dashboardId)); }, [dashboardId, dispatch]);

  const now = new Date();
  const onPurge = (id: string, title: string) => {
    if (!window.confirm(`Permanently delete "${title}"? This can't be undone.`)) return;
    dispatch(purgeWorkflow(id));
  };
// when clicking a run and the run card pops up, make the card pop up slightly more to the right.
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: WC.paper }}>
      <div style={{ flex: 'none', padding: '22px 30px 14px', borderBottom: `1px solid ${WC.line}` }}>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: WC.muted2, marginBottom: 5 }}>Deleted workflows</div>
        <h1 style={{ margin: 0, fontFamily: FONT_SERIF, fontSize: 29, fontWeight: 500, color: WC.ink, letterSpacing: '-0.015em' }}>Trash</h1>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '18px 30px 32px' }}>
        {deleted.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {deleted.map((w) => (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 14, background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.md, padding: '13px 16px' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: colorForWorkflow(w) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: WC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.title || 'Untitled workflow'}</div>
                  <div style={{ fontSize: 12, color: WC.muted, marginTop: 2 }}>{w.deleted_at ? `Deleted ${whenText(new Date(w.deleted_at), now)}` : 'Deleted'} · {w.steps.length} step{w.steps.length === 1 ? '' : 's'}</div>
                </div>
                <button onClick={() => dispatch(restoreWorkflow(w.id))} style={{ background: WC.raised, border: `1px solid rgba(${WC.inkRGB},0.14)`, borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, color: WC.ink, cursor: 'pointer', flex: 'none' }}>Restore</button>
                <button onClick={() => onPurge(w.id, w.title || 'this workflow')} style={{ background: WC.dangerBg, border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, color: WC.danger, cursor: 'pointer', flex: 'none' }}>Delete forever</button>
              </div>
            ))}
          </div>
        ) : (
          !loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '84px 20px', textAlign: 'center' }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: WC.inset, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={WC.faint} strokeWidth="1.7"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
              </div>
              <div style={{ fontFamily: FONT_SERIF, fontSize: 18, color: WC.ink, marginBottom: 4 }}>Trash is empty</div>
              <div style={{ fontSize: 13, color: WC.muted, maxWidth: 300, lineHeight: 1.5 }}>Deleted workflows appear here. Restore them or remove them permanently.</div>
            </div>
          )
        )}
      </div>
    </div>
  );
};

export default TrashView;
