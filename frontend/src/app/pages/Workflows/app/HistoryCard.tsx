import React, { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchRuns } from '@/shared/state/workflowsSlice';
import { openWorkflowMonitor } from '@/shared/state/dashboardLayoutSlice';
import { openCardContextMenu } from '@/app/pages/Dashboard/desktop/openCardContextMenu';
import { useWC, FONT_SERIF, statusChip, statusDot, statusLabel } from './uiKit';
import type { WCPalette } from './uiKit';
import { toRunRow, whenText } from './model';
import { useCloudRuns } from './useCloudRuns';
import { toCloudHistoryRow } from './cloudRunRow';
import type { CloudHistoryRow } from './cloudRunRow';

interface Entry extends CloudHistoryRow {
  where: 'device' | 'cloud';
  open?: () => void;
}

const Row: React.FC<{ entry: Entry; wc: WCPalette; now: Date }> = ({ entry, wc, now }) => (
  <div
    onClick={entry.open}
    title={entry.open ? 'Open this run' : undefined}
    onContextMenu={(e) => openCardContextMenu(e, {
      items: [
        { label: 'Open run', disabled: !entry.open, onClick: () => entry.open?.() },
        { label: 'Copy summary', onClick: () => { navigator.clipboard.writeText(entry.summary); } },
      ],
    })}
    style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: `1px solid rgba(${wc.inkRGB},0.05)`, cursor: entry.open ? 'pointer' : 'default' }}
  >
    <div style={statusDot(entry.tone, wc)} />
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Why a run did not happen is a sentence, not a label, so let it wrap rather than ellipsing the part that answers the question. */}
      <div title={entry.summary} style={{ fontSize: 12.5, color: wc.ink2, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 }}>{entry.summary}</div>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: wc.muted2, marginTop: 2 }}>
        {[entry.where === 'cloud' ? 'Cloud' : null, whenText(entry.when, now), entry.durationText, entry.costText]
          .filter(Boolean)
          .join(' · ')}
      </div>
    </div>
    <span style={statusChip(entry.tone, wc)}>{entry.label}</span>
  </div>
);

const HistoryCard: React.FC<{ workflowId: string; title: string }> = ({ workflowId, title }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const runs = useAppSelector((s) => s.workflows.runs[workflowId]);
  const workflow = useAppSelector((s) => s.workflows.items[workflowId]);
  const onCloud = workflow?.execution_target === 'cloud';
  const cloudRuns = useCloudRuns(workflowId, onCloud, workflow?.updated_at ?? '');

  useEffect(() => { dispatch(fetchRuns(workflowId)); }, [workflowId, dispatch]);

  const local: Entry[] = (runs || []).map((r) => {
    const row = toRunRow(r, title);
    return {
      id: row.id,
      label: statusLabel(row.status),
      tone: row.status,
      summary: row.summary,
      when: row.when,
      durationText: row.durationText,
      costText: '',
      where: 'device',
      open: () => dispatch(openWorkflowMonitor({ workflowId, runId: row.id })),
    };
  });
  const remote: Entry[] =
    cloudRuns.phase === 'answered' && cloudRuns.response.state === 'ready'
      ? cloudRuns.response.runs.map((r) => ({ ...toCloudHistoryRow(r, title), where: 'cloud' as const }))
      : [];
  const rows = [...local, ...remote]
    .sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0))
    .slice(0, 8);

  // A history we could not load is not an empty history, and must never be drawn as one.
  const cloudBlind =
    onCloud && (cloudRuns.phase === 'checking' || (cloudRuns.phase === 'answered' && cloudRuns.response.state !== 'ready'));
  const now = new Date();

  return (
    <div style={{ background: WC.paper, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: WC.radius.lg, padding: 16 }}>
      <div style={{ fontFamily: FONT_SERIF, fontSize: 16, fontWeight: 500, color: WC.ink, marginBottom: 12 }}>History</div>
      {rows.length === 0 && !cloudBlind && <div style={{ fontSize: 12.5, color: WC.muted2 }}>No runs yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((entry) => <Row key={`${entry.where}-${entry.id}`} entry={entry} wc={WC} now={now} />)}
      </div>
      {cloudBlind && (
        <div style={{ fontSize: 11.5, color: WC.muted2, marginTop: rows.length ? 10 : 0 }}>
          {cloudRuns.phase === 'checking'
            ? 'Loading cloud runs…'
            : 'Couldn’t load this workflow’s cloud runs, so any that ran are not shown here.'}
        </div>
      )}
    </div>
  );
};

export default HistoryCard;
