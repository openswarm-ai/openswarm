import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Snackbar from '@mui/material/Snackbar';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/EditOutlined';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import PlayArrowIcon from '@mui/icons-material/PlayArrowRounded';
import ScheduleIcon from '@mui/icons-material/ScheduleRounded';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  closeWorkflowCard,
  deleteWorkflow,
  fetchRuns,
  openWorkflowCard as openWorkflowCardAction,
  rekeyOpenCard,
  runWorkflowNow,
  updateWorkflow,
  updateWorkflowCard,
  type Workflow,
} from '@/shared/state/workflowsSlice';
import {
  rekeyWorkflowCard,
  removeWorkflowCard,
  setWorkflowCardPosition,
  setWorkflowCardSize,
} from '@/shared/state/dashboardLayoutSlice';
import { AnimatePresence, motion } from 'framer-motion';
import WorkflowEditViews from './WorkflowEditViews';
import { HistoryDetail, HistoryList, PreviewView, SavedView } from './WorkflowCardSubviews';
import { StatusDot, RunSparkline, LastFiredHint, isStaleSinceLastRun } from './workflowVisuals';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;
const MIN_W = 360;
const MIN_H = 280;

const CURSOR_MAP: Record<ResizeDir, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};

// Resize handles sit at zIndex 25 so they win against the drag-header
// (zIndex 16). Same fix that landed on BrowserCard for the top edge.
const HANDLE_DEFS: { dir: ResizeDir; sx: Record<string, any> }[] = [
  { dir: 'n',  sx: { top: -EDGE_THICKNESS / 2, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_THICKNESS } },
  { dir: 's',  sx: { bottom: -EDGE_THICKNESS / 2, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_THICKNESS } },
  { dir: 'w',  sx: { left: -EDGE_THICKNESS / 2, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_THICKNESS } },
  { dir: 'e',  sx: { right: -EDGE_THICKNESS / 2, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_THICKNESS } },
  { dir: 'nw', sx: { top: -EDGE_THICKNESS / 2, left: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
  { dir: 'ne', sx: { top: -EDGE_THICKNESS / 2, right: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
  { dir: 'sw', sx: { bottom: -EDGE_THICKNESS / 2, left: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
  { dir: 'se', sx: { bottom: -EDGE_THICKNESS / 2, right: -EDGE_THICKNESS / 2, width: CORNER_SIZE, height: CORNER_SIZE } },
];

interface Props {
  workflowId: string;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  cardZOrder?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view' | 'browser' | 'note' | 'workflow', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view' | 'browser' | 'note' | 'workflow') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onDoubleClick?: (id: string, type: 'agent' | 'view' | 'browser' | 'note' | 'workflow') => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser' | 'note' | 'workflow') => void;
}

const WorkflowCard: React.FC<Props> = ({
  workflowId,
  cardX, cardY, cardWidth, cardHeight, cardZOrder = 0,
  zoom = 1, panX = 0, panY = 0,
  isSelected = false, isHighlighted = false, multiDragDelta,
  onCardSelect, onDragStart, onDragMove, onDragEnd, onDoubleClick, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();

  const card = useAppSelector((s) => s.workflows.openCards[workflowId]);
  const workflow = useAppSelector((s) => s.workflows.items[workflowId]);
  const runs = useAppSelector((s) => s.workflows.runs[workflowId]);
  // Transient "Starting…" label state on the Run button. See onClick handler
  // for the full rationale (avoid no-feedback flicker on fast manual runs).
  const [runStarting, setRunStarting] = useState(false);
  const [runToast, setRunToast] = useState<string | null>(null);
  const [editDirty, setEditDirty] = useState(false);
  // First-success celebration: one tiny burst the first time the
  // workflow ever reaches success. We track the celebration in localStorage
  // keyed by workflow id so we don't repeat it across reloads.
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!workflow || !runs || runs.length === 0) return;
    const successes = runs.filter((r) => r.status === 'success');
    if (successes.length !== 1) return;
    const key = `openswarm:first-success:${workflow.id}`;
    if (typeof localStorage !== 'undefined' && localStorage.getItem(key)) return;
    setCelebrate(true);
    try { localStorage.setItem(key, '1'); } catch { /* private mode etc. */ }
    const t = window.setTimeout(() => setCelebrate(false), 2200);
    return () => window.clearTimeout(t);
  }, [workflow?.id, runs]);

  // Lazy-load runs whenever a view that needs them is open. Saved view
  // uses runs for the live-fill connector + step duration estimates;
  // History views obviously need them too.
  useEffect(() => {
    if (!card) return;
    const needsRuns = card.view === 'saved' || card.view === 'history' || card.view === 'history_detail';
    if (needsRuns && workflow && !runs) {
      dispatch(fetchRuns(workflow.id));
    }
  }, [card?.view, workflow?.id, runs, dispatch]);

  // Keep wheel-scroll inside the card body instead of letting it bubble
  // up to the dashboard pan/zoom listener. Without this, scrolling the
  // schedule/history list shifts the canvas underneath the card. Mirrors
  // the chat-panel wheel guard in AgentChat.tsx. Ctrl/meta + wheel is
  // intentionally allowed through so canvas zoom still works when the
  // cursor is over a workflow card.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const scrollingDown = e.deltaY > 0;
      const scrollingUp = e.deltaY < 0;
      if ((scrollingUp && atTop) || (scrollingDown && atBottom)) {
        e.preventDefault();
      }
      e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const title = workflow?.title || card?.draft?.title || 'Workflow';
  const isDraft = card?.view === 'preview' && !workflow;
  const steps = (workflow?.steps || card?.draft?.steps || []) as Workflow['steps'];

  // ---- Card drag via title bar ----
  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });

  const panRef = useRef({ panX, panY });
  panRef.current = { panX, panY };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Don't start a card-drag when the press lands on an interactive
    // child (the close button, action chips, step inputs). The header
    // also hosts the X icon — bailing here is what makes the X actually
    // clickable (the old overlay's setPointerCapture swallowed the click).
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag], button, [role="button"], input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: cardX, origY: cardY,
      startPanX: panRef.current.panX, startPanY: panRef.current.panY,
    };
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(workflowId, 'workflow');
  }, [cardX, cardY, onDragStart, workflowId]);

  const recomputeDragPos = useCallback(() => {
    const ds = dragState.current;
    if (!ds || !didDrag.current) return;
    const { clientX, clientY } = lastPointerRef.current;
    const z = zoomRef.current;
    const panDx = (panRef.current.panX - ds.startPanX) / z;
    const panDy = (panRef.current.panY - ds.startPanY) / z;
    const dx = (clientX - ds.startX) / z - panDx;
    const dy = (clientY - ds.startY) / z - panDy;
    setLocalDragPos({ x: ds.origX + dx, y: ds.origY + dy });
    onDragMove?.(dx, dy, clientX, clientY);
  }, [onDragMove]);

  useEffect(() => {
    if (isDragging && didDrag.current) recomputeDragPos();
  }, [panX, panY, isDragging, recomputeDragPos]);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    recomputeDragPos();
  }, [recomputeDragPos]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const z = zoomRef.current;
    const panDx = (panRef.current.panX - dragState.current.startPanX) / z;
    const panDy = (panRef.current.panY - dragState.current.startPanY) / z;
    const dx = (e.clientX - dragState.current.startX) / z - panDx;
    const dy = (e.clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      if (!e.shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }
      dispatch(setWorkflowCardPosition({ workflowId, x: finalX, y: finalY }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, workflowId, onDragEnd]);

  // ---- Resize ----
  const resizeRef = useRef<{
    dir: ResizeDir; startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        dir, startX: e.clientX, startY: e.clientY,
        origX: cardX, origY: cardY, origW: cardWidth, origH: cardHeight,
      };
      setIsResizing(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [cardX, cardY, cardWidth, cardHeight],
  );

  const computeResize = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return null;
      const { dir, startX, startY, origX, origY, origW, origH } = resizeRef.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      let newX = origX, newY = origY, newW = origW, newH = origH;
      if (dir.includes('e')) newW = origW + dx;
      if (dir.includes('w')) { newW = origW - dx; newX = origX + dx; }
      if (dir.includes('s')) newH = origH + dy;
      if (dir.includes('n')) { newH = origH - dy; newY = origY + dy; }
      if (newW < MIN_W) { if (dir.includes('w')) newX = origX + origW - MIN_W; newW = MIN_W; }
      if (newH < MIN_H) { if (dir.includes('n')) newY = origY + origH - MIN_H; newH = MIN_H; }
      return { x: newX, y: newY, w: newW, h: newH };
    },
    [zoom],
  );

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const result = computeResize(e);
      if (result) setLocalResize(result);
    },
    [computeResize],
  );

  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const result = computeResize(e);
    if (result) {
      dispatch(setWorkflowCardPosition({ workflowId, x: result.x, y: result.y }));
      dispatch(setWorkflowCardSize({ workflowId, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, workflowId]);

  // ---- Close: drop transient view state AND remove from layout ----
  // Two-step when the schedule is on: a quiet X would make the workflow
  // a "ghost" (still firing on a hidden timer) which surprises users who
  // mentally model X as "throw away." Confirm-then-act lets them choose
  // between hiding the card and actually killing the schedule.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const hardClose = useCallback(() => {
    dispatch(closeWorkflowCard(workflowId));
    dispatch(removeWorkflowCard(workflowId));
  }, [dispatch, workflowId]);
  const onClose = useCallback(() => {
    if (workflow?.schedule?.enabled) {
      setCloseConfirmOpen(true);
      return;
    }
    hardClose();
  }, [workflow?.schedule?.enabled, hardClose]);
  const onConfirmHide = useCallback(() => {
    setCloseConfirmOpen(false);
    hardClose();
  }, [hardClose]);
  const onConfirmStopAndDelete = useCallback(async () => {
    setCloseConfirmOpen(false);
    if (workflow?.id) {
      await dispatch(deleteWorkflow(workflow.id));
    }
    hardClose();
  }, [dispatch, workflow?.id, hardClose]);

  // ---- Display calculations ----
  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  if (!card) return null;

  const border = isHighlighted
    ? `2px solid ${c.accent.primary}`
    : isSelected
      ? '2px solid #3b82f6'
      : `1px solid ${c.border.medium}`;

  const shadow = isHighlighted
    ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
    : isDragging || isResizing
      ? c.shadow.lg
      : isSelected
        ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
        : c.shadow.md;

  return (
    <Box
      data-select-type="workflow-card"
      data-select-id={workflowId}
      data-select-meta={JSON.stringify({ name: title })}
      onPointerDownCapture={() => onBringToFront?.(workflowId, 'workflow')}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(workflowId, 'workflow', e.shiftKey);
      }}
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onDoubleClick?.(workflowId, 'workflow');
      }}
      sx={{
        position: 'absolute',
        contain: 'layout style',
        willChange: 'transform',
        left: displayX,
        top: displayY,
        width: displayW,
        height: displayH,
        borderRadius: `${c.radius.lg}px`,
        border,
        bgcolor: c.bg.surface,
        boxShadow: shadow,
        display: 'flex',
        flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.4s ease, border 0.3s ease',
        '&:hover .resize-handle': { opacity: 1 },
      }}
    >
      {/* ===== Title bar / drag handle ===== */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1,
          px: 1.75, py: 1.1,
          borderBottom: `1px solid ${c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none', userSelect: 'none',
          flexShrink: 0,
          zIndex: 16,
          position: 'relative',
        }}
      >
        <DragIndicatorIcon sx={{ fontSize: 16, color: c.text.ghost }} />
        <StatusDot status={workflow?.last_run_status} />
        <Typography sx={{ flex: 1, fontWeight: 700, fontSize: '0.95rem', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </Typography>
        {runs && runs.length > 0 && <RunSparkline runs={runs} />}
        <IconButton
          size="small"
          data-no-drag
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ p: 0.5, color: c.text.ghost, '&:hover': { color: c.status.error, bgcolor: c.status.errorBg } }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* ===== Action bar ===== */}
      {!isDraft && workflow && (
        <Box sx={{ display: 'flex', gap: 0.6, px: 2, py: 1, borderBottom: `1px solid ${c.border.subtle}`, flexWrap: 'wrap', flexShrink: 0 }}>
          <TabBtn
            label={runStarting ? 'Starting…' : 'Run'}
            icon={<PlayArrowIcon sx={{ fontSize: 16 }} />}
            active={card.view === 'saved'}
            accent
            breathe={!runStarting && isStaleSinceLastRun(workflow)}
            breatheTooltip="Haven't run this in a few days. Click to run it now."
            onClick={async () => {
              if (runStarting) return;
              setRunStarting(true);
              dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history' } }));
              try {
                const result = await dispatch(runWorkflowNow(workflow.id));
                await dispatch(fetchRuns(workflow.id));
                // Detect skipped manual runs so the user gets a real
                // explanation instead of a silent button-flicker. The
                // most common skip today is the monthly cost cap.
                if (runWorkflowNow.fulfilled.match(result)) {
                  const payload = result.payload;
                  if (payload.status === 'skipped' && payload.error) {
                    setRunToast(`Run skipped: ${payload.error}`);
                  }
                }
              } finally {
                // Hold the "Starting…" label briefly so the user sees the
                // state change even on fast runs. Without this the button
                // flickers and feels like nothing happened.
                setTimeout(() => setRunStarting(false), 600);
              }
            }}
          />
          <TabBtn
            label="Edit"
            icon={<EditIcon sx={{ fontSize: 16 }} />}
            active={card.view === 'edit'}
            dot={editDirty}
            dotTooltip="You have unsaved changes in this tab."
            onClick={() => dispatch(updateWorkflowCard({ workflowId, patch: { view: 'edit', editFacet: card.editFacet || 'General' } }))}
          />
          <TabBtn
            label="History"
            icon={<HistoryIcon sx={{ fontSize: 16 }} />}
            active={card.view === 'history' || card.view === 'history_detail'}
            onClick={() => dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history' } }))}
          />
          {!workflow.schedule.enabled && (
            <Box sx={{ ml: 'auto' }}>
              <TabBtn
                label="Schedule this task"
                icon={<ScheduleIcon sx={{ fontSize: 16 }} />}
                active={false}
                onClick={() => {
                  // One-click arming: flip the master toggle ON with a
                  // sensible default (daily 9am if there's nothing set
                  // yet), then jump to the editor so the user can tweak.
                  // Saves the extra "open editor → flip toggle → save"
                  // dance for the common case.
                  const sched = workflow.schedule;
                  const next = {
                    ...sched,
                    enabled: true,
                    // If the workflow has never had a schedule, day-1 9am
                    // is the friendliest default. If we already had one
                    // (re-enabling after a pause), keep the user's prior
                    // settings untouched.
                    repeat_unit: sched.repeat_unit || 'day',
                    repeat_every: sched.repeat_every || 1,
                    hour: sched.hour || 9,
                    minute: sched.minute || 0,
                  };
                  dispatch(updateWorkflow({
                    id: workflow.id,
                    patch: { schedule: next as any },
                    ifMatch: workflow.updated_at || null,
                  }));
                  dispatch(updateWorkflowCard({ workflowId, patch: { view: 'edit', editFacet: 'Schedule' } }));
                }}
              />
            </Box>
          )}
        </Box>
      )}

      {/* ===== Body — view-specific subview =====
          Crossfades between Run/Edit/History tabs so the swap doesn't
          read as a "jump". Outer box is the scrollable viewport; the
          animated child changes per `card.view`. */}
      <Box ref={bodyScrollRef} data-no-drag sx={{ flex: 1, p: 2, overflowY: 'auto', minHeight: 0, position: 'relative', overscrollBehavior: 'contain' }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={card.view}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}>
        {card.view === 'preview' && (
          <PreviewView
            workflowId={workflowId}
            steps={steps}
            sourceSessionId={card.sourceSessionId || null}
            initialDraft={card.draft || null}
            onSaved={(wf) => {
              // Migrate transient view state AND layout entry to the
              // real workflow id so the card stays put visually.
              dispatch(rekeyOpenCard({ oldId: workflowId, newId: wf.id }));
              dispatch(rekeyWorkflowCard({ oldId: workflowId, newId: wf.id }));
              dispatch(openWorkflowCardAction({
                workflowId: wf.id,
                sourceSessionId: card.sourceSessionId,
                view: 'saved',
                draft: null,
              }));
            }}
          />
        )}
        {card.view === 'saved' && workflow && (
          <SavedView
            workflow={workflow}
            steps={steps}
            runs={runs}
            activeRunId={(runs || []).find((r) => r.status === 'running')?.id || null}
          />
        )}
        {card.view === 'edit' && workflow && (
          <WorkflowEditViews
            workflow={workflow}
            facet={card.editFacet || 'General'}
            onChangeFacet={(f) => dispatch(updateWorkflowCard({ workflowId, patch: { editFacet: f } }))}
            onDirtyChange={setEditDirty}
          />
        )}
        {card.view === 'history' && workflow && (
          <HistoryList
            runs={runs || []}
            onOpen={(run) => dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history_detail', historyRunId: run.id } }))}
          />
        )}
        {card.view === 'history_detail' && workflow && (
          <HistoryDetail
            run={(runs || []).find((r) => r.id === card.historyRunId) || null}
            onBack={() => dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history' } }))}
          />
        )}
          </motion.div>
        </AnimatePresence>
      </Box>

      {/* ===== Resize handles ===== */}
      {HANDLE_DEFS.map(({ dir, sx }) => (
        <Box
          key={dir}
          className="resize-handle"
          onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          sx={{
            position: 'absolute',
            cursor: CURSOR_MAP[dir],
            opacity: 0,
            zIndex: 25,
            ...sx,
          }}
        />
      ))}
      {/* First-success celebration. Tiny CSS-only sparkle so we don't
          pull in a confetti library. ~2s self-clears via the effect. */}
      {celebrate && (
        <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 30 }}>
          <Box sx={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            fontSize: '1.4rem', fontWeight: 700, color: c.accent.primary,
            bgcolor: c.bg.surface, px: 1.2, py: 0.5, borderRadius: 999,
            boxShadow: c.shadow.md,
            animation: 'first-success-pop 1.4s ease-out forwards',
            '@keyframes first-success-pop': {
              '0%':   { opacity: 0, transform: 'translate(-50%,-50%) scale(0.6)' },
              '20%':  { opacity: 1, transform: 'translate(-50%,-50%) scale(1.08)' },
              '60%':  { opacity: 1, transform: 'translate(-50%,-50%) scale(1.0)' },
              '100%': { opacity: 0, transform: 'translate(-50%,-50%) scale(1.0)' },
            },
          }}>
            🎉 First success
          </Box>
        </Box>
      )}
      {/* Toast for run outcomes that need explaining beyond the History
          row (cost cap, "previous run still active," etc.). Auto-hides
          after 6s; user can click anywhere to dismiss. */}
      <Snackbar
        open={Boolean(runToast)}
        autoHideDuration={6000}
        onClose={() => setRunToast(null)}
        message={runToast || ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      {/* Ghost-protection dialog: only opens when an enabled-schedule
          card is X'd out. Cancel keeps the card; "Hide card" closes
          but leaves the schedule alive; "Stop & delete" wipes the
          workflow entirely. */}
      <Dialog open={closeConfirmOpen} onClose={() => setCloseConfirmOpen(false)}>
        <DialogTitle>Close this workflow card?</DialogTitle>
        <DialogContent>
          The schedule will keep firing in the background even after you close this card. Choose what you want to happen.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCloseConfirmOpen(false)}>Cancel</Button>
          <Button onClick={onConfirmHide}>Hide card (schedule keeps running)</Button>
          <Button color="error" onClick={onConfirmStopAndDelete}>Stop &amp; delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

function TabBtn({ label, icon, active, accent, breathe, breatheTooltip, dot, dotTooltip, onClick }: { label: string; icon: React.ReactNode; active: boolean; accent?: boolean; breathe?: boolean; breatheTooltip?: string; dot?: boolean; dotTooltip?: string; onClick: () => void }) {
  const c = useClaudeTokens();
  const btn = (
    <Box
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      role="button"
      data-no-drag
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.5,
        px: 1.1, py: 0.5,
        fontSize: '0.82rem', fontWeight: 600,
        color: active ? c.accent.primary : c.text.secondary,
        bgcolor: active || accent ? c.accent.primary + '14' : 'transparent',
        border: `1px solid ${active || accent ? c.accent.primary + '40' : c.border.subtle}`,
        borderRadius: `${c.radius.md}px`,
        cursor: 'pointer', userSelect: 'none',
        '&:hover': { bgcolor: c.accent.primary + '10' },
        // Subtle "ready" breath when a stale workflow's Run button hasn't
        // been touched in over 24h. ~3% scale + glow swell, slow enough
        // to read as ambient rather than urgent. Tooltip is on so users
        // don't think the button is malfunctioning.
        ...(breathe && {
          animation: 'workflow-run-breath 3.2s ease-in-out infinite',
          '@keyframes workflow-run-breath': {
            '0%, 100%': { boxShadow: `0 0 0 ${c.accent.primary}00`, transform: 'scale(1)' },
            '50%': { boxShadow: `0 0 14px ${c.accent.primary}55`, transform: 'scale(1.03)' },
          },
        }),
      }}>
      {icon}
      {label}
      {dot && (
        <Box sx={{
          width: 7, height: 7, borderRadius: '50%',
          bgcolor: c.accent.primary,
          ml: 0.25,
        }} />
      )}
    </Box>
  );
  if (dot && dotTooltip) {
    return <Tooltip title={dotTooltip}>{btn}</Tooltip>;
  }
  if (breathe && breatheTooltip) {
    return <Tooltip title={breatheTooltip}>{btn}</Tooltip>;
  }
  return btn;
}

export default React.memo(WorkflowCard);
