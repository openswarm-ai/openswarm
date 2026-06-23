import React, { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchRuns } from '@/shared/state/workflowsSlice';
import { openWorkflowMonitor } from '@/shared/state/dashboardLayoutSlice';
import { useWC, FONT_SERIF, statusChip, statusDot, statusLabel } from './uiKit';
import { toRunRow, whenText } from './model';

const HistoryCard: React.FC<{ workflowId: string; title: string }> = ({ workflowId, title }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const runs = useAppSelector((s) => s.workflows.runs[workflowId]);

  useEffect(() => { dispatch(fetchRuns(workflowId)); }, [workflowId, dispatch]);

  const rows = (runs || []).slice(0, 8).map((r) => toRunRow(r, title));
  const now = new Date();

  return (
    <div style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.lg, padding: 16 }}>
      <div style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink, marginBottom: 12 }}>History</div>
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: WC.muted2 }}>No runs yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((r) => (
          <div key={r.id} onClick={() => dispatch(openWorkflowMonitor({ workflowId, runId: r.id }))} title="Open this run" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: `1px solid rgba(${WC.inkRGB},0.05)`, cursor: 'pointer' }}>
            <div style={statusDot(r.status, WC)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: WC.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.summary}</div>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: WC.muted2, marginTop: 2 }}>
                {whenText(r.when, now)}{r.durationText ? ` · ${r.durationText}` : ''}
              </div>
            </div>
            <span style={statusChip(r.status, WC)}>{statusLabel(r.status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default HistoryCard;
