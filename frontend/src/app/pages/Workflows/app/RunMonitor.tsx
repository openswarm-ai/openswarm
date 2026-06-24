import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import { fetchRuns, controlWorkflowRun } from '@/shared/state/workflowsSlice';
import type { Workflow, WorkflowRun } from '@/shared/state/workflowsSlice';
import {
  bringToFront, closeWorkflowMonitor, setWorkflowsMonitorPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { CardType } from '@/shared/state/dashboardLayoutSlice';
import WorkflowTitle from './WorkflowTitle';

type StepState = 'done' | 'running' | 'failed' | 'pending';
const DRAG_THRESHOLD = 3;

function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function kindLabel(run: WorkflowRun | null): string {
  if (!run) return 'RUN';
  if (run.triggered_by === 'manual') return 'MANUAL RUN';
  if (run.triggered_by === 'retry') return 'RE-RUN';
  return 'SCHEDULED RUN';
}

interface Props {
  workflow: Workflow;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  cardZOrder: number;
  zoom: number;
  panX: number;
  panY: number;
  onDragStart: (id: string, type: CardType) => void;
  onDragMove: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd: (dx: number, dy: number, didDrag: boolean) => void;
}

// The live run view, a real canvas card (standard claudeTokens chrome) spawned
// beside the Workflows window. The orange connector back to the window is drawn
// by the shared TetherLayer, same mechanism as an agent spinning up a browser.
const RunMonitor: React.FC<Props> = ({ workflow, cardX, cardY, cardWidth, cardHeight, cardZOrder, zoom, panX, panY, onDragStart, onDragMove, onDragEnd }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const runs = useAppSelector((s) => s.workflows.runs[workflow.id]);
  const allRuns = useAppSelector((s) => s.workflows.allRuns);
  const monitorRunId = useAppSelector((s) => s.dashboardLayout.workflowsMonitorRunId);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => { dispatch(fetchRuns(workflow.id)); }, [workflow.id, dispatch]);

  const panRef = useRef({ panX, panY });
  panRef.current = { panX, panY };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const dragState = useRef<{ sx: number; sy: number; ox: number; oy: number; spx: number; spy: number } | null>(null);
  const didDrag = useRef(false);
  const [localPos, setLocalPos] = useState<{ x: number; y: number } | null>(null);

  const onHeaderDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, [role="button"]')) return;
    e.preventDefault(); e.stopPropagation();
    dispatch(bringToFront({ id: 'workflows-monitor', type: 'workflows-monitor' }));
    dragState.current = { sx: e.clientX, sy: e.clientY, ox: cardX, oy: cardY, spx: panRef.current.panX, spy: panRef.current.panY };
    didDrag.current = false;
    onDragStart('workflows-monitor', 'workflows-monitor');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, dispatch, onDragStart]);

  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rdx = e.clientX - dragState.current.sx;
    const rdy = e.clientY - dragState.current.sy;
    if (!didDrag.current && Math.sqrt(rdx * rdx + rdy * rdy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const z = zoomRef.current;
    const pdx = (panRef.current.panX - dragState.current.spx) / z;
    const pdy = (panRef.current.panY - dragState.current.spy) / z;
    const dx = rdx / z - pdx;
    const dy = rdy / z - pdy;
    setLocalPos({ x: dragState.current.ox + dx, y: dragState.current.oy + dy });
    // Feed the shared drag channel so the tether tracks live, same as cards.
    onDragMove(dx, dy, e.clientX, e.clientY);
  }, [onDragMove]);

  const onHeaderUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const z = zoomRef.current;
    const pdx = (panRef.current.panX - dragState.current.spx) / z;
    const pdy = (panRef.current.panY - dragState.current.spy) / z;
    const dx = (e.clientX - dragState.current.sx) / z - pdx;
    const dy = (e.clientY - dragState.current.sy) / z - pdy;
    if (didDrag.current) {
      let nx = dragState.current.ox + dx;
      let ny = dragState.current.oy + dy;
      if (!e.shiftKey) { nx = Math.round(nx / 24) * 24; ny = Math.round(ny / 24) * 24; }
      dispatch(setWorkflowsMonitorPosition({ x: nx, y: ny }));
    }
    onDragEnd(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalPos(null);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, onDragEnd]);

  // A pinned run id (clicked from history) wins; otherwise follow the latest run.
  const run: WorkflowRun | null =
    (monitorRunId
      ? (runs || []).find((r) => r.id === monitorRunId) || allRuns.find((r) => r.id === monitorRunId)
      : (runs && runs[0]) || allRuns.find((r) => r.workflow_id === workflow.id))
    || null;
  const isRunning = run?.status === 'running';

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  const steps = workflow.steps.filter((s) => s.enabled !== false && s.text && s.text.trim());
  const total = steps.length;
  const aidx = run?.active_step_idx ?? 0;
  const failed = run?.status === 'failure';
  const succeeded = run?.status === 'success' || run?.status === 'ran_late';
  const sessionId = run?.session_id || null;

  const stepState = (i: number): StepState => {
    if (succeeded) return 'done';
    if (failed) return i < aidx ? 'done' : i === aidx ? 'failed' : 'pending';
    if (isRunning) return i < aidx ? 'done' : i === aidx ? 'running' : 'pending';
    return 'pending';
  };

  const pct = total > 0
    ? Math.round((succeeded ? total : Math.min(aidx + (isRunning ? 0.5 : 0), total)) / total * 100)
    : (isRunning ? 10 : 0);

  const startedMs = run?.started_at ? new Date(run.started_at).getTime() : nowTick;
  const endMs = run?.finished_at ? new Date(run.finished_at).getTime() : nowTick;
  const clock = fmtClock((isRunning ? nowTick : endMs) - startedMs);

  const headStatus = isRunning ? 'Running' : succeeded ? 'Done' : failed ? 'Failed' : 'Idle';
  const headColor = isRunning ? c.accent.primary : succeeded ? c.status.success : failed ? c.status.error : c.text.tertiary;
  const headBg = isRunning ? c.bg.secondary : succeeded ? c.status.successBg : failed ? c.status.errorBg : c.bg.secondary;

  const progressLabel = isRunning
    ? `Step ${Math.min(aidx + 1, total)} of ${total}`
    : succeeded ? `All ${total} steps complete` : failed ? `Failed at step ${Math.min(aidx + 1, total)}` : `${total} steps`;

  const close = () => dispatch(closeWorkflowMonitor());
  const stopRun = () => { if (run?.id) dispatch(controlWorkflowRun({ runId: run.id, action: 'stop' })); };

  const x = localPos?.x ?? cardX;
  const y = localPos?.y ?? cardY;

  return (
    <div
      data-select-type="workflows-monitor-card"
      data-select-id="workflows-monitor"
      onPointerDownCapture={() => dispatch(bringToFront({ id: 'workflows-monitor', type: 'workflows-monitor' }))}
      style={{
        position: 'absolute', left: x, top: y, width: cardWidth, height: cardHeight,
        background: c.bg.surface, border: `1px solid ${c.border.medium}`, borderRadius: c.radius.lg,
        boxShadow: c.shadow.lg, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        zIndex: cardZOrder, contain: 'layout style',
      }}
    >
      {/* title bar (drag handle) */}
      <div
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        style={{ height: 44, flex: 'none', display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px 0 14px', borderBottom: `1px solid ${c.border.subtle}`, background: c.bg.elevated, cursor: localPos ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
      >
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: headColor, flex: 'none', ...(isRunning ? { animation: 'os-pulse 1.1s ease-in-out infinite' } : {}) }} />
        <WorkflowTitle value={workflow.title} animate={workflow.auto_named !== false}>
          {(t) => <span style={{ fontSize: 13.5, fontWeight: 600, color: c.text.primary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>}
        </WorkflowTitle>
        <span style={{ fontSize: 11, fontWeight: 600, color: headColor, background: headBg, padding: '2px 9px', borderRadius: 999, flex: 'none' }}>{headStatus}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: c.text.tertiary, flex: 'none' }}>{clock}</span>
        <IconButton onClick={close} aria-label="Close" size="small" sx={{ flex: 'none', color: c.text.tertiary, '&:hover': { color: c.status.error, bgcolor: `${c.status.error}14` } }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>

      {/* progress subhead */}
      <div style={{ flex: 'none', padding: '14px 16px 13px', borderBottom: `1px solid ${c.border.subtle}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, letterSpacing: '0.07em', color: c.text.tertiary }}>{kindLabel(run)}</span>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: c.text.tertiary }}>{pct}%</span>
        </div>
        <div style={{ height: 5, borderRadius: 999, background: c.bg.secondary, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: failed ? c.status.error : c.accent.primary, transition: 'width .4s ease' }} />
        </div>
        <div style={{ fontSize: 12, color: c.text.secondary, marginTop: 8 }}>{progressLabel}</div>
      </div>

      {/* workflow steps (bounded; the live chat fills the rest) */}
      <div style={{ flex: sessionId ? 'none' : 1, maxHeight: sessionId ? '40%' : undefined, overflowY: 'auto', minHeight: 0, padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 7, borderBottom: sessionId ? `1px solid ${c.border.subtle}` : undefined }}>
        {steps.map((s, i) => {
          const st = stepState(i);
          const iconBg = st === 'done' ? c.status.success : st === 'failed' ? c.status.error : st === 'running' ? c.accent.primary : c.bg.secondary;
          return (
            <div key={s.id} style={{ background: st === 'running' ? c.bg.elevated : 'transparent', border: `1px solid ${st === 'running' ? c.border.medium : c.border.subtle}`, borderRadius: c.radius.md, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', flex: 'none', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {st === 'done' && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2"><path d="M5 12l5 5L20 6" /></svg>}
                  {st === 'running' && <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff', animation: 'os-spin 0.7s linear infinite' }} />}
                  {st === 'failed' && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2"><path d="M6 6l12 12M18 6L6 18" /></svg>}
                </div>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: st === 'pending' ? c.text.tertiary : c.text.primary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label || s.text.slice(0, 48)}</span>
                {st === 'done' && <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: c.text.tertiary, flex: 'none' }}>done</span>}
              </div>
              {st === 'running' && run?.last_tool_label && (
                <div style={{ marginTop: 8, paddingLeft: 32, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: c.accent.primary, marginTop: 6, flex: 'none' }} />
                  <span style={{ fontSize: 11.5, color: c.text.secondary, lineHeight: 1.45 }}>{run.last_tool_label}</span>
                </div>
              )}
            </div>
          );
        })}
        {total === 0 && <div style={{ fontSize: 12.5, color: c.text.tertiary }}>This workflow has no runnable steps.</div>}
      </div>

      {/* live transcript: read-only (prompts we send, agent responses, tool calls). Reuses AgentChat. */}
      {sessionId ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <AgentChat sessionId={sessionId} embedded readOnly />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: c.text.tertiary }}>
          {isRunning ? 'Waiting for the run to start…' : failed ? 'This run failed before any agent ran.' : 'No agent chat for this run.'}
        </div>
      )}

      {/* footer only while live: Stop fully fails the in-flight run. Once it's
          done there are no buttons; the title-bar X closes the card. */}
      {isRunning && (
        <div style={{ flex: 'none', borderTop: `1px solid ${c.border.subtle}`, background: c.bg.elevated, padding: '11px 14px 13px', display: 'flex', gap: 9 }}>
          <button onClick={stopRun} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: c.status.errorBg, border: `1px solid ${c.status.error}33`, borderRadius: c.radius.md, padding: 9, fontSize: 13, fontWeight: 600, color: c.status.error, cursor: 'pointer' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            <span>Stop run</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default RunMonitor;
