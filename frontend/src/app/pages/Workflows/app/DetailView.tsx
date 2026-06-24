import React, { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { runWorkflowNow } from '@/shared/state/workflowsSlice';
import { openWorkflowMonitor, setWorkflowsRunContext, clearWorkflowsRunContext } from '@/shared/state/dashboardLayoutSlice';
import { stepsSignature, isScheduleActive } from '@/app/pages/Workflows/scheduleUtils';
import { askRun } from './api';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import InlineEditableTitle from '@/app/components/InlineEditableTitle';
import { Typewriter } from '@/app/components/feedback/Animated';
import { useWC, colorForWorkflow, statusChip } from './uiKit';
import { isRunning, runContextChip } from './model';
import { useEditAgentSession } from './useEditAgentSession';
import { useWorkflowPatch } from './useWorkflowPatch';
import ScheduleCard from './ScheduleCard';
import StepsCard from './StepsCard';
import HistoryCard from './HistoryCard';
import ColorSwatch from './ColorSwatch';
import type { AppNav } from './types';

const DetailView: React.FC<{ workflowId: string; nav: AppNav }> = ({ workflowId }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const patch = useWorkflowPatch();
  const workflow = useAppSelector((s) => s.workflows.items[workflowId]);
  const active = useAppSelector((s) => s.workflows.active);
  const sessionId = useEditAgentSession(workflowId);
  const detailRuns = useAppSelector((s) => s.workflows.runs[workflowId]);
  const runContext = useAppSelector((s) => s.dashboardLayout.workflowsRunContext);
  // When you Run now from this chat, attach that run as a context chip once it
  // finishes, so the next question rides on its transcript (removable, no popup).
  const autoCtxRunId = useRef<string | null>(null);

  useEffect(() => {
    const rid = autoCtxRunId.current;
    if (!rid) return;
    const r = (detailRuns || []).find((x) => x.id === rid);
    if (!r || r.status === 'running') return;
    autoCtxRunId.current = null;
    if (workflow) dispatch(setWorkflowsRunContext(runContextChip(workflow, r)));
  }, [detailRuns, workflowId, dispatch, workflow]);

  if (!workflow) return <div style={{ flex: 1, background: WC.page }} />;

  const running = isRunning(workflow, active);
  const enabled = isScheduleActive(workflow.schedule);
  const status = running ? 'running' : enabled ? 'success' : 'paused';
  const statusText = running ? 'Running' : enabled ? 'Active' : 'Paused';

  const runNow = () => {
    if (running) return;
    dispatch(runWorkflowNow({ id: workflow.id, signature: stepsSignature(workflow.steps) }))
      .unwrap().then((res) => { autoCtxRunId.current = res.run_id || null; }).catch(() => {});
    dispatch(openWorkflowMonitor({ workflowId: workflow.id }));
  };

  return (
    <>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: WC.page }}>
        <div style={{ flex: 'none', padding: '20px 28px 16px', borderBottom: `1px solid rgba(${WC.inkRGB},0.06)` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <ColorSwatch value={colorForWorkflow(workflow)} onChange={(hex) => patch(workflow, { color: hex })} size={14} />
            <InlineEditableTitle
              value={workflow.title || ''}
              onCommit={(t) => patch(workflow, { title: t, auto_named: false })}
              placeholder="Untitled workflow"
              sx={{ flex: 1, minWidth: 0, fontFamily: "'Newsreader',serif", fontSize: 25, fontWeight: 500, color: WC.ink, letterSpacing: '-0.01em' }}
            >
              <Typewriter value={workflow.title || 'Untitled workflow'} enabled={workflow.auto_named !== false}>
                {(t) => (
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'Newsreader',serif", fontSize: 25, fontWeight: 500, color: WC.ink, letterSpacing: '-0.01em' }}>{t}</span>
                )}
              </Typewriter>
            </InlineEditableTitle>
            <span style={statusChip(status, WC)}>{statusText}</span>
            <button onClick={runNow} disabled={running} style={{ display: 'flex', alignItems: 'center', gap: 8, background: running ? WC.inset : WC.ink, color: running ? WC.muted : WC.paper, border: 'none', borderRadius: 9, padding: '8px 15px', fontSize: 13, fontWeight: 600, cursor: running ? 'default' : 'pointer', flex: 'none' }}>
              {running
                ? <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(140,133,122,0.3)', borderTopColor: WC.muted, animation: 'os-spin 0.7s linear infinite', flex: 'none' }} />
                : <div style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: `8px solid ${WC.paper}`, flex: 'none' }} />}
              <span>{running ? 'Running…' : 'Run'}</span>
            </button>
          </div>
          {workflow.description && <div style={{ fontSize: 13.5, color: WC.muted, marginTop: 7, paddingLeft: 27 }}>{workflow.description}</div>}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {sessionId
            ? <AgentChat
                sessionId={sessionId}
                embedded
                workflowEditId={workflow.id}
                runContext={runContext?.workflowId === workflow.id ? runContext : undefined}
                onClearRunContext={() => dispatch(clearWorkflowsRunContext())}
                onSendRunQuestion={(prompt, runId) => askRun(workflow.id, { runId, prompt }).then((ok) => { if (!ok) throw new Error('ask-run failed'); })}
              />
            : <div style={{ flex: 1 }} />}
        </div>
      </div>

      <div style={{ width: 344, flex: 'none', borderLeft: `1px solid ${WC.line}`, background: WC.rail, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '18px 18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ScheduleCard workflow={workflow} />
          <StepsCard workflow={workflow} />
          <HistoryCard workflowId={workflow.id} title={workflow.title} />
        </div>
      </div>
    </>
  );
};

export default DetailView;
