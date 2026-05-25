import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion } from 'framer-motion';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Snackbar from '@mui/material/Snackbar';
import CloseIcon from '@mui/icons-material/Close';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import PlayArrowIcon from '@mui/icons-material/PlayArrowRounded';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import InputBase from '@mui/material/InputBase';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  closeWorkflowCard,
  fetchRuns,
  openWorkflowCard as openWorkflowCardAction,
  rekeyOpenCard,
  runWorkflowNow,
  updateWorkflow,
  updateWorkflowCard,
  type Workflow,
} from '@/shared/state/workflowsSlice';
import {
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  placeCard,
  rekeyWorkflowCard,
  removeWorkflowCard,
  setWorkflowCardPosition,
  setWorkflowCardSize,
} from '@/shared/state/dashboardLayoutSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import WorkflowEditViews from './WorkflowEditViews';
import { HistoryDetail, HistoryList, PreviewView, SavedView } from './WorkflowCardSubviews';
import { CompletedView, FailedView, RunningView } from './WorkflowCardLiveViews';
import SchedulingView from './SchedulingView';
import EditAgentView from './EditAgentView';
import StopRounded from '@mui/icons-material/StopRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import { StatusDot, RunSparkline, LastFiredHint, isStaleSinceLastRun } from './workflowVisuals';
import { store } from '@/shared/state/store';
import { getAgentWorkTime } from '@/shared/agentWorkTime';

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
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);

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
    const needsRuns =
      card.view === 'saved' ||
      card.view === 'history' ||
      card.view === 'history_detail' ||
      card.view === 'running' ||
      card.view === 'completed' ||
      card.view === 'failed';
    if (needsRuns && workflow && !runs) {
      dispatch(fetchRuns(workflow.id));
    }
  }, [card?.view, workflow?.id, runs, dispatch]);

  // Layout state (workflowCards in dashboardLayoutSlice) persists across
  // app restarts; workflows.openCards in workflowsSlice does NOT — it's a
  // transient view-state cache. On relaunch the user sees the workflow
  // card position restored AND the source-chat tether redrawn, but the
  // card body itself doesn't render because openCards is empty. Auto-
  // create a Saved-view openCard once we know the workflow really exists
  // server-side. Without this, the user sees only the orange tether arrow
  // pointing at nothing.
  useEffect(() => {
    if (!workflow || card) return;
    dispatch(openWorkflowCardAction({
      workflowId: workflow.id,
      sourceSessionId: workflow.source_session_id || null,
      view: 'saved',
      draft: null,
    }));
  }, [workflow?.id, card, dispatch]);

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

  // X just hides the card. Schedule keeps firing in the background; the
  // user can re-open from the Workflows hub. A confirm dialog here was
  // more friction than value (users clicked through it without reading).
  const onClose = useCallback(() => {
    dispatch(closeWorkflowCard(workflowId));
    dispatch(removeWorkflowCard(workflowId));
  }, [dispatch, workflowId]);

  // ---- Display calculations ----
  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  // Chat views embed a full AgentChat that needs a fixed scroll viewport;
  // every other view should size to its content so nothing is cut off and
  // there's no dead space below short content. While the user is actively
  // resizing, honor the dragged height.
  // Chat views host a composer + conversation, so they keep a bounded height
  // (composer docked at the bottom, content scrolls) like a normal chat card.
  // Everything else fits to its content. Scheduling is a chat too (you talk to
  // it in natural language), so it belongs here, not in the fit-to-content set.
  const isChatView = card?.view === 'edit_agent' || card?.view === 'fix_agent' || card?.view === 'scheduling';
  const autoHeight = !isChatView && !localResize && !isResizing;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  if (!card) return null;

  const isRunning = (runs || []).some((r) => r.status === 'running') || workflow?.last_run_status === 'running';

  // Hairline border for the default idle state (item #19 in target #54
  // diff). Keeps the card feeling like a soft surface, not a fenced
  // box. Highlighted / selected / running still bump up so feedback
  // is unambiguous.
  const border = isHighlighted
    ? `2px solid ${c.accent.primary}`
    : isSelected
      ? '2px solid #3b82f6'
      : isRunning
        ? `1px solid ${c.accent.primary}80`
        : `1px solid ${c.border.subtle}`;

  const shadow = isHighlighted
    ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
    : isDragging || isResizing
      ? c.shadow.lg
      : isSelected
        ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
        : c.shadow.md;

  return (
    <Box
      component={motion.div}
      // Mount animation: a soft pop-in matching AgentCard's spawn so the
      // Convert-to-workflow swap doesn't feel instant. Springy scale +
      // opacity over ~220ms; no position morph because the card already
      // lands at the source chat's exact coords (handled in AgentCard's
      // convert handler).
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ scale: { type: 'spring', stiffness: 320, damping: 26, mass: 0.6 }, opacity: { duration: 0.18 } }}
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
        height: autoHeight ? 'auto' : displayH,
        maxHeight: autoHeight ? 'min(82vh, 760px)' : undefined,
        borderRadius: '14px',
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
      {/* ===== Title bar / drag handle =====
          Matches target image #54 spec: drag-grip on the far left, then a
          single bold title (no pill prefix), then a quiet close X. The
          run-status indicator moved to the inline "Scheduled:" prose
          below so the title row stays calm. Padding bumped from 1.1 to
          1.4 vertical so the title has air around it. */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1,
          px: 2, py: 1.4,
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none', userSelect: 'none',
          flexShrink: 0,
          zIndex: 16,
          position: 'relative',
        }}
      >
        <DragIndicatorIcon sx={{ fontSize: 18, color: c.text.muted }} />
        {isDraft ? (
          // Draft state: title is inline-editable. Patches the openCard's
          // draft.title so PreviewView picks it up on Save. Saved cards
          // keep the read-only Typography below.
          <InputBase
            data-no-drag
            onPointerDown={(e) => e.stopPropagation()}
            value={(card?.draft?.title as string) || ''}
            placeholder="New workflow"
            onChange={(e) => dispatch(updateWorkflowCard({ workflowId, patch: { draft: { ...(card?.draft || {}), title: e.target.value } } }))}
            sx={{
              flex: 1, fontWeight: 600, fontSize: '0.95rem', color: c.text.primary,
              letterSpacing: '-0.005em',
              '& input::placeholder': { color: c.text.muted, opacity: 1 },
            }}
          />
        ) : (
          <>
            <Typography sx={{ fontWeight: 600, fontSize: '0.95rem', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.005em' }}>
              {title}
            </Typography>
            <StatusPill view={card.view} workflow={workflow} runs={runs} />
            <Box sx={{ flex: 1 }} />
          </>
        )}
        {runs && runs.length > 0 && <RunSparkline runs={runs} />}
        <IconButton
          size="small"
          data-no-drag
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ p: 0.5, color: c.text.secondary, '&:hover': { color: c.status.error, bgcolor: c.status.errorBg } }}
        >
          <CloseIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Box>

      {/* Action bar matches new design: History + Run flush-right (Edit moved to footer).
          The flex spacer is the empty left side; History is a quiet text link, Run is the
          accent pill. */}
      {isDraft && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 2, pb: 1.25, pt: 0, flexShrink: 0 }}>
          <SubtitleRow
            workflow={null}
            runs={null}
            fallbackModel={card?.draft?.model}
            fallbackMode={card?.draft?.mode}
            fallbackSourceSessionId={card?.draft?.source_session_id}
          />
          <Box sx={{ flex: 1 }} />
          <TabBtn label="History" icon={<HistoryIcon sx={{ fontSize: 16 }} />} active={false} onClick={() => {}} />
          <TabBtn label="Run" icon={<PlayArrowIcon sx={{ fontSize: 16 }} />} active={false} accent onClick={() => {}} />
        </Box>
      )}
      {!isDraft && workflow && !isHeaderlessView(card.view) && card.view !== 'running' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 2, pb: 1.25, pt: 0, flexShrink: 0 }}>
          <SubtitleRow workflow={workflow} runs={runs} />
          <Box sx={{ flex: 1 }} />
          <TabBtn
            label="History"
            icon={<HistoryIcon sx={{ fontSize: 16 }} />}
            active={card.view === 'history' || card.view === 'history_detail'}
            onClick={() => dispatch(updateWorkflowCard({ workflowId, patch: { view: (card.view === 'history' || card.view === 'history_detail') ? 'saved' : 'history' } }))}
          />
          <TabBtn
            label={runStarting ? 'Starting…' : 'Run'}
            icon={<PlayArrowIcon sx={{ fontSize: 16 }} />}
            active={false}
            accent
            breathe={!runStarting && isStaleSinceLastRun(workflow)}
            breatheTooltip="Haven't run this in a few days. Click to run it now."
            onClick={async () => {
              if (runStarting) return;
              setRunStarting(true);
              try {
                const result = await dispatch(runWorkflowNow(workflow.id));
                await dispatch(fetchRuns(workflow.id));
                if (runWorkflowNow.fulfilled.match(result)) {
                  const payload = result.payload;
                  if (payload.status === 'skipped' && payload.error) {
                    setRunToast(`Run skipped: ${payload.error}`);
                  }
                }
              } finally {
                setTimeout(() => setRunStarting(false), 600);
              }
            }}
          />
        </Box>
      )}
      {!isDraft && workflow && card.view === 'running' && (
        <RunningHeader workflowId={workflowId} />
      )}

      {/* ===== Body — view-specific subview =====
          Crossfades between Run/Edit/History tabs so the swap doesn't
          read as a "jump". Outer box is the scrollable viewport; the
          animated child changes per `card.view`. */}
      <Box ref={bodyScrollRef} data-no-drag sx={{ flex: 1, p: 2, overflowY: 'auto', minHeight: 0, position: 'relative', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', borderTop: `1px solid ${c.border.subtle}` }}>
        {/* No AnimatePresence wrapper here on purpose: framer-motion's
            crossfade was racing user-input events and stealing focus
            from the title/description/step InputBases on every parent
            re-render (Redux dispatches from selection/zOrder/etc.). The
            tab body just swaps directly; the user doesn't notice the
            missing crossfade. */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
            onOpen={async (run) => {
              if (!run.session_id) {
                dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history_detail', historyRunId: run.id } }));
                return;
              }
              const sid = run.session_id;
              if (!store.getState().agents.sessions[sid]) {
                try { await dispatch(fetchSession(sid)).unwrap(); } catch { /* fall back to detail */ }
              }
              if (!store.getState().agents.sessions[sid]) {
                dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history_detail', historyRunId: run.id } }));
                return;
              }
              if (!store.getState().dashboardLayout.cards[sid]) {
                dispatch(placeCard({
                  sessionId: sid,
                  x: cardX + cardWidth + 60,
                  y: cardY,
                  width: DEFAULT_CARD_W,
                  height: DEFAULT_CARD_H,
                  expandedSessionIds,
                }));
              }
              dispatch(setPendingFocusAgentId(sid));
            }}
          />
        )}
        {card.view === 'history_detail' && workflow && (
          <HistoryDetail
            run={(runs || []).find((r) => r.id === card.historyRunId) || null}
            onBack={() => dispatch(updateWorkflowCard({ workflowId, patch: { view: 'history' } }))}
          />
        )}
        {card.view === 'running' && workflow && (
          <RunningView workflow={workflow} steps={steps} runs={runs} mode={card.sidecarKind === 'watching' ? 'sidecar-linked' : 'card'} />
        )}
        {card.view === 'completed' && workflow && (
          <CompletedView workflow={workflow} steps={steps} runs={runs} mode={card.sidecarKind === 'viewing-completed' ? 'sidecar-linked' : 'card'} />
        )}
        {card.view === 'failed' && workflow && (
          <FailedView workflow={workflow} steps={steps} runs={runs} mode={card.sidecarKind === 'viewing-error' ? 'sidecar-linked' : 'card'} />
        )}
        {card.view === 'scheduling' && workflow && (
          <SchedulingView workflow={workflow} steps={steps} />
        )}
        {(card.view === 'edit_agent' || card.view === 'fix_agent') && workflow && (
          <EditAgentView workflow={workflow} steps={steps} isFixMode={card.view === 'fix_agent'} />
        )}
        </Box>
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
    </Box>
  );
};

function isHeaderlessView(view: string): boolean {
  // Edit-agent / fix-agent / scheduling render their own Discard/Save
  // (or Cancel) header inside the body so the parent skips the default
  // History/Run row to avoid two stacked toolbars.
  return view === 'edit_agent' || view === 'fix_agent' || view === 'scheduling';
}

function StatusPill({ view, workflow, runs }: { view: string; workflow: Workflow | undefined; runs: import('@/shared/state/workflowsSlice').WorkflowRun[] | undefined }) {
  const c = useClaudeTokens();
  // Pills appear on the title row to mirror Image #34 (completed source
  // chat), #40 (running), #42 (completed workflow), #41 (running while
  // watching). Saved / Preview / Edit / Scheduling have no pill.
  let label = '';
  let color = c.text.muted;
  let bg = c.bg.elevated;
  if (view === 'running') {
    label = 'running';
    color = c.status.success;
    bg = c.status.successBg;
  } else if (view === 'completed') {
    label = 'completed';
    color = c.text.secondary;
    bg = c.bg.elevated;
  } else {
    // Image #46: failed view has NO pill in the title row; the red X
    // on the failed step row carries the signal. Preview/Saved/Edit/
    // Scheduling are likewise pill-less.
    void workflow; void runs;
    return null;
  }
  return (
    <Box sx={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: '0.74rem', fontWeight: 600,
      px: 0.8, py: 0.18, borderRadius: `${c.radius.md}px`,
      color, bgcolor: bg,
      ml: 0.25,
    }}>{label}</Box>
  );
}

function SubtitleRow({ workflow, runs, fallbackModel, fallbackMode, fallbackSourceSessionId }: {
  workflow: Workflow | null;
  runs: import('@/shared/state/workflowsSlice').WorkflowRun[] | null;
  fallbackModel?: string;
  fallbackMode?: string;
  fallbackSourceSessionId?: string | null;
}) {
  const c = useClaudeTokens();
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  // Draft preview has no workflow yet; fall back to the converting chat's
  // model/mode and use its work time for the "28s" so the subtitle reads the
  // same as the source chat card did.
  const sourceSession = useAppSelector((s) => fallbackSourceSessionId ? s.agents.sessions[fallbackSourceSessionId] : undefined);
  // Match Image #34/#35/#36/#38/#40: "Claude Opus 4.6  agent  28s".
  // Spaces between fields, all in muted text.
  const effModel = workflow?.model || fallbackModel || '';
  const modelLabel = React.useMemo(() => {
    if (!effModel) return '';
    for (const list of Object.values(modelsByProvider || {})) {
      for (const m of (list as any[]) || []) {
        if (m.value === effModel) return m.label || effModel;
      }
    }
    return effModel;
  }, [effModel, modelsByProvider]);
  const modeLabel = workflow?.mode || fallbackMode || '';
  const duration = React.useMemo(() => {
    const finished = (runs || []).find((r) => r.finished_at);
    if (finished && finished.finished_at) {
      const ms = new Date(finished.finished_at).getTime() - new Date(finished.started_at).getTime();
      if (ms > 0) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
        return `${Math.floor(ms / 60_000)}m`;
      }
    }
    if (sourceSession) {
      const { total } = getAgentWorkTime(sourceSession.messages || [], sourceSession.status);
      if (total > 0) return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m`;
    }
    return '';
  }, [runs, sourceSession]);
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25, fontSize: '0.82rem', color: c.text.muted, minWidth: 0, overflow: 'hidden' }}>
      {modelLabel && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{modelLabel}</Box>}
      {modeLabel && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{modeLabel}</Box>}
      {duration && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{duration}</Box>}
    </Box>
  );
}

function RunningHeader({ workflowId }: { workflowId: string }) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflowId]);
  const workflow = useAppSelector((s) => s.workflows.items[workflowId]);
  const runs = useAppSelector((s) => s.workflows.runs[workflowId]);
  const runId = card?.runId || null;
  const run = (runs || []).find((r) => r.id === runId);
  const onStop = React.useCallback(async () => {
    if (!run) return;
    try {
      const { API_BASE, getAuthToken } = await import('@/shared/config');
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      await fetch(`${API_BASE}/workflows/runs/${encodeURIComponent(run.id)}/stop`, {
        method: 'POST',
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
    } catch { /* best-effort */ }
    dispatch(updateWorkflowCard({ workflowId, patch: { view: 'saved', runId: null } }));
  }, [dispatch, workflowId, run]);
  // Pause = "let this run finish, but stop firing future schedules."
  // Can't actually pause a streaming agent turn mid-call, so we flip
  // schedule.enabled so the scheduler stops queuing the next fire. The
  // button label flips to "Resume" while paused; user can re-enable
  // without leaving the running view.
  const isPaused = !!workflow && !workflow.schedule.enabled && workflow.schedule.runs_count > 0;
  const onPauseToggle = React.useCallback(async () => {
    if (!workflow) return;
    const next = { ...workflow.schedule, enabled: isPaused };
    await dispatch(updateWorkflow({
      id: workflow.id,
      patch: { schedule: next as Workflow['schedule'] },
      ifMatch: workflow.updated_at || null,
    }));
  }, [dispatch, workflow, isPaused]);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 2, pb: 1.25, pt: 0, flexShrink: 0 }}>
      <SubtitleRow workflow={workflow || null} runs={runs || null} />
      <Box sx={{ flex: 1 }} />
      <Box
        onClick={onStop}
        role="button"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, fontSize: '0.82rem', fontWeight: 600, px: 1, py: 0.4, color: c.text.secondary, cursor: 'pointer', borderRadius: 999, '&:hover': { color: c.text.primary, bgcolor: c.bg.elevated } }}>
        <StopRounded sx={{ fontSize: 15 }} />
        Stop
      </Box>
      <Tooltip title={isPaused ? 'Schedule is paused. Click to resume future fires.' : 'Pause future scheduled fires. This run finishes normally.'}>
        <Box
          onClick={onPauseToggle}
          role="button"
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.35,
            fontSize: '0.82rem', fontWeight: 700,
            px: 1.1, py: 0.4, borderRadius: 999,
            bgcolor: c.accent.primary, color: '#fff', cursor: 'pointer',
            '&:hover': { filter: 'brightness(1.05)' },
          }}>
          <PauseRounded sx={{ fontSize: 15 }} />
          {isPaused ? 'Resume' : 'Pause'}
        </Box>
      </Tooltip>
    </Box>
  );
}

function TabBtn({ label, icon, active, accent, breathe, breatheTooltip, dot, dotTooltip, onClick }: { label: string; icon: React.ReactNode; active: boolean; accent?: boolean; breathe?: boolean; breatheTooltip?: string; dot?: boolean; dotTooltip?: string; onClick: () => void }) {
  const c = useClaudeTokens();
  const btn = (
    <Box
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      role="button"
      data-no-drag
      sx={{
        // Consistent visual weight across Run/Edit/History per target
        // #54: identical padding + border thickness, matched 32px row
        // height. `accent` (Run only) gets the colored text + tinted bg
        // so it reads as the primary verb without screaming "selected".
        // Tabs no longer flip the bg on `active`; the body view itself
        // tells the user where they are.
        display: 'inline-flex', alignItems: 'center', gap: 0.5,
        px: 1.25, py: 0.5,
        minHeight: 32,
        fontSize: '0.82rem', fontWeight: 600,
        whiteSpace: 'nowrap',
        color: accent ? c.accent.primary : c.text.secondary,
        bgcolor: accent ? c.accent.primary + '14' : 'transparent',
        // Only the Run (accent) tab carries a border; Edit/History sit as
        // quiet text-with-icon affordances so the primary verb stands out.
        border: accent ? `1px solid ${c.accent.primary}50` : '1px solid transparent',
        borderRadius: `${c.radius.md}px`,
        cursor: 'pointer', userSelect: 'none',
        '&:hover': { bgcolor: accent ? c.accent.primary + '22' : c.bg.elevated, borderColor: accent ? c.accent.primary : 'transparent' },
        // Active state: nudge bg only when this is a non-accent tab so the
        // user can still see "you're on this view". Run's accent styling
        // already does that job; piling a darker bg on top reads as
        // disabled.
        ...(active && !accent && {
          color: c.text.primary,
          bgcolor: c.bg.elevated,
        }),
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
