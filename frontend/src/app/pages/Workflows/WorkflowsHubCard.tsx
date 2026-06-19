import React, { useCallback, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import SearchIcon from '@mui/icons-material/Search';
import MenuIcon from '@mui/icons-material/Menu';
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  addWorkflowCard,
  closeWorkflowsHub,
  setWorkflowsHubPosition,
  setWorkflowsHubSize,
} from '@/shared/state/dashboardLayoutSlice';
import { openWorkflowCard, createWorkflow, fetchPausedState, setPausedAll, updateWorkflow, deleteWorkflow, runWorkflowNow } from '@/shared/state/workflowsSlice';
import type { Workflow } from '@/shared/state/workflowsSlice';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import { useEffect } from 'react';
import ScheduleCalendar from './ScheduleCalendar';
import AddToSchedulePopover from './AddToSchedulePopover';
import { WEEKDAY_LABEL, addDays, sameDay, startOfMonthGrid, isWorkflowSchedulable, stepsSignature } from './scheduleUtils';
import { isRealTitle } from './workflowVisuals';
import { Typewriter } from '@/app/components/feedback/Animated';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;
const MIN_W = 720;
const MIN_H = 420;

const CURSOR_MAP: Record<ResizeDir, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};

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
  onCardSelect?: (id: string, type: 'workflows-hub', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'workflows-hub') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBringToFront?: (id: string, type: 'workflows-hub') => void;
}

type CalendarView = 'Week' | 'Month' | 'List';

// Small badge in the hub header that adds up successful scheduled runs
// across all workflows and renders an approximate "time saved" figure.
// Heuristic: 3 minutes saved per scheduled run that the user would have
// otherwise done by hand. Not precise — meant as a quiet "you got back
// X hours" affirmation, not an audit number.
function TimeSavedBadge() {
  const c = useClaudeTokens();
  const runsByWorkflow = useAppSelector((s) => s.workflows.runs);
  const items = useAppSelector((s) => s.workflows.items);
  let count = 0;
  for (const arr of Object.values(runsByWorkflow)) {
    for (const r of arr) {
      if (r.triggered_by === 'schedule' && (r.status === 'success' || r.status === 'ran_late')) count += 1;
    }
  }
  // Fallback: if no runs are loaded yet (cards never opened), use
  // last_run_status as a coarse proxy so brand-new users don't see 0.
  if (count === 0) {
    for (const w of Object.values(items)) {
      if (w.last_run_status === 'success' || w.last_run_status === 'ran_late') count += 1;
    }
  }
  if (count === 0) return null;
  const totalMin = count * 3;
  const hours = totalMin / 60;
  // Show "X done · ~Y hrs" so the user gets both the run count and a
  // sense of time. Dot-separator reads quieter than the old green pill.
  const timeLabel = hours >= 1 ? `~${hours.toFixed(1)} hrs` : `~${totalMin} min`;
  return (
    <Tooltip title={`${count} workflow runs completed for you. Rough estimate of ~3 min saved per run vs. doing it by hand.`}>
      <Box sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.5,
        ml: 1, px: 0.85, py: 0.2,
        fontSize: '0.74rem', fontWeight: 600,
        color: c.text.secondary,
        bgcolor: 'transparent',
        border: `1px solid ${c.border.subtle}`,
        borderRadius: 999,
      }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: '50%', bgcolor: (c.status.success || c.accent.primary) + '22', color: c.status.success || c.accent.primary, fontSize: 9, fontWeight: 800 }}>✓</Box>
        <span style={{ color: c.text.primary }}>{count}</span>
        <span style={{ color: c.text.muted }}>·</span>
        <span style={{ color: c.text.secondary }}>{timeLabel} back</span>
      </Box>
    </Tooltip>
  );
}

const WorkflowsHubCard: React.FC<Props> = ({
  cardX, cardY, cardWidth, cardHeight, cardZOrder = 0,
  zoom = 1, panX = 0, panY = 0,
  isSelected = false, isHighlighted = false, multiDragDelta = null,
  onCardSelect, onDragStart, onDragMove, onDragEnd, onBringToFront,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const workflows = useAppSelector((s) => s.workflows.items);
  const paused = useAppSelector((s) => s.workflows.paused);
  const defaultModel = useAppSelector((s) => s.settings.data.default_model);

  useEffect(() => { dispatch(fetchPausedState()); }, [dispatch]);

  const togglePaused = useCallback(() => {
    dispatch(setPausedAll(!paused));
  }, [dispatch, paused]);

  const [view, setView] = useState<CalendarView>('List');
  const [viewOpen, setViewOpen] = useState(false);
  const [refDate, setRefDate] = useState(new Date());

  // The hub card lives on the canvas for days at a time, so a refDate frozen
  // at mount leaves the calendar stuck on the day it was opened (e.g. still
  // showing "yesterday" past midnight). Roll it forward when the day flips,
  // but only if the user was parked on today, so manual navigation is left be.
  const refDateRef = useRef(refDate);
  refDateRef.current = refDate;
  useEffect(() => {
    let lastToday = new Date();
    const id = window.setInterval(() => {
      const now = new Date();
      if (sameDay(now, lastToday)) return;
      if (sameDay(refDateRef.current, lastToday)) setRefDate(now);
      lastToday = now;
    }, 60000);
    return () => window.clearInterval(id);
  }, []);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Right-click on a sidebar row opens this menu pinned to the cursor.
  // Mirrors the calendar pill context menu so the two surfaces feel
  // consistent. closeMenu wipes both state + DOM-focus.
  const [sidebarCtxMenu, setSidebarCtxMenu] = useState<{ x: number; y: number; workflow: Workflow } | null>(null);
  const closeSidebarCtxMenu = useCallback(() => setSidebarCtxMenu(null), []);
  // Anchored off an Unscheduled row's "+" icon: opens the scheduler.
  const [schedulePopover, setSchedulePopover] = useState<{ anchorEl: HTMLElement; workflow: Workflow } | null>(null);
  const closeSchedulePopover = useCallback(() => setSchedulePopover(null), []);

  // "Scheduled" = the workflow has a real cadence configured at any
  // point (even if currently paused via the checkbox). Filtering by
  // `enabled` would yank rows out from under the user the moment they
  // unticked the box, which feels wrong. on_days/hour/minute being set
  // is a good proxy for "user already configured this." Falls back to
  // enabled flag for legacy records.
  // Hide brand-new "+ New" workflows that the user is still building and
  // hasn't saved yet; commit (Save) clears `unsaved` and they appear.
  const saved = useMemo(() => Object.values(workflows).filter((w) => !w.unsaved), [workflows]);
  const scheduled = useMemo(() => saved.filter((w) => isWorkflowSchedulable(w)), [saved]);
  const unscheduled = useMemo(() => saved.filter((w) => !isWorkflowSchedulable(w)), [saved]);

  const monthLabel = refDate.toLocaleString('en', { month: 'long', year: 'numeric' });

  const onSelectWorkflow = useCallback((wid: string) => {
    dispatch(addWorkflowCard({ workflowId: wid }));
    dispatch(openWorkflowCard({ workflowId: wid, view: 'saved' }));
  }, [dispatch]);

  // A from-scratch workflow has no steps to convert, so skip the chat->workflow
  // PreviewView (Schedule prompt / blank bullet) and drop straight into the
  // Edit Agent build chat: the user describes it, the agent writes the steps.
  // The workflow is created server-side first so the embedded edit-agent
  // session has a real id to attach to; an abandoned (still 0-step) one is
  // cleaned up on card close (WorkflowCard.onClose).
  const onNew = useCallback(async () => {
    // Clean up any abandoned empty drafts first so "New" always starts fresh
    // instead of leaving a half-built 0-step workflow lingering on the canvas.
    Object.values(workflows)
      .filter((w) => w.unsaved && (w.steps?.length ?? 0) === 0)
      .forEach((w) => dispatch(deleteWorkflow(w.id)));
    // Build on the user's chosen default model (not a hardcoded one) so the
    // Edit Agent, and the scheduled runs, use the model they actually intend.
    const result = await dispatch(createWorkflow({ title: 'New workflow', steps: [], unsaved: true, model: defaultModel }));
    if (!createWorkflow.fulfilled.match(result)) return;
    const wf = result.payload;
    dispatch(addWorkflowCard({ workflowId: wf.id }));
    dispatch(openWorkflowCard({ workflowId: wf.id, view: 'edit_agent' }));
  }, [dispatch, workflows, defaultModel]);

  // ---- Card drag via header ----
  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  const panRef = useRef({ panX, panY });
  panRef.current = { panX, panY };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag], button, [role="button"], input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: cardX, origY: cardY,
      startPanX: panRef.current.panX, startPanY: panRef.current.panY,
    };
    didDrag.current = false;
    setIsDragging(true);
    onDragStart?.('workflows-hub', 'workflows-hub');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, onDragStart]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const z = zoomRef.current;
    const panDx = (panRef.current.panX - dragState.current.startPanX) / z;
    const panDy = (panRef.current.panY - dragState.current.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({
      x: dragState.current.origX + dx,
      y: dragState.current.origY + dy,
    });
    onDragMove?.(dx, dy, e.clientX, e.clientY);
  }, [onDragMove]);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const z = zoomRef.current;
    const panDx = (panRef.current.panX - dragState.current.startPanX) / z;
    const panDy = (panRef.current.panY - dragState.current.startPanY) / z;
    const dx = (e.clientX - dragState.current.startX) / z - panDx;
    const dy = (e.clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 0);
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      if (!e.shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }
      dispatch(setWorkflowsHubPosition({ x: finalX, y: finalY }));
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, onDragEnd]);

  // ---- Resize ----
  const resizeRef = useRef<{ dir: ResizeDir; sx0: number; sy0: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const onResizeDown = useCallback((dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { dir, sx0: e.clientX, sy0: e.clientY, ox: cardX, oy: cardY, ow: cardWidth, oh: cardHeight };
    setIsResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, cardWidth, cardHeight]);

  const compute = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return null;
    const { dir, sx0, sy0, ox, oy, ow, oh } = resizeRef.current;
    const dx = (e.clientX - sx0) / zoom;
    const dy = (e.clientY - sy0) / zoom;
    let nx = ox, ny = oy, nw = ow, nh = oh;
    if (dir.includes('e')) nw = ow + dx;
    if (dir.includes('w')) { nw = ow - dx; nx = ox + dx; }
    if (dir.includes('s')) nh = oh + dy;
    if (dir.includes('n')) { nh = oh - dy; ny = oy + dy; }
    if (nw < MIN_W) { if (dir.includes('w')) nx = ox + ow - MIN_W; nw = MIN_W; }
    if (nh < MIN_H) { if (dir.includes('n')) ny = oy + oh - MIN_H; nh = MIN_H; }
    return { x: nx, y: ny, w: nw, h: nh };
  }, [zoom]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = compute(e);
    if (r) setLocalResize(r);
  }, [compute]);

  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = compute(e);
    if (r) {
      dispatch(setWorkflowsHubPosition({ x: r.x, y: r.y }));
      dispatch(setWorkflowsHubSize({ width: r.w, height: r.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [compute, dispatch]);

  const mdDx = (!isDragging && !isResizing && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && !isResizing && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const dx = (localResize?.x ?? localDragPos?.x ?? cardX) + mdDx;
  const dy = (localResize?.y ?? localDragPos?.y ?? cardY) + mdDy;
  const dw = localResize?.w ?? cardWidth;
  const dh = localResize?.h ?? cardHeight;
  const border = isHighlighted
    ? `2px solid ${c.accent.primary}`
    : isSelected
      ? '2px solid #3b82f6'
      : `1px solid ${c.border.medium}`;
  const shadow = isHighlighted
    ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
    : (isDragging || isResizing)
      ? c.shadow.lg
      : isSelected
        ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
        : c.shadow.md;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  return (
    <Box
      data-select-type="workflows-hub-card"
      data-select-id="workflows-hub"
      data-select-meta={JSON.stringify({ name: 'Workflows calendar' })}
      onPointerDownCapture={(e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-no-drag]')) return;
        onBringToFront?.('workflows-hub', 'workflows-hub');
      }}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        const target = e.target as HTMLElement;
        if (target.closest('[data-no-drag]')) return;
        onCardSelect?.('workflows-hub', 'workflows-hub', e.shiftKey);
      }}
      sx={{
        position: 'absolute',
        contain: 'layout style',
        willChange: 'transform',
        left: dx,
        top: dy,
        width: dw,
        height: dh,
        bgcolor: c.bg.surface,
        border,
        borderRadius: `${c.radius.lg}px`,
        boxShadow: shadow,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.3s ease, border-color 0.2s ease',
        '&:hover .resize-handle': { opacity: 1 },
      }}
    >
      {/* ===== Title strip (drag handle) ===== */}
      <Box
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.6,
          px: 1.5, py: 0.5,
          bgcolor: c.bg.elevated,
          borderBottom: `1px solid ${c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none', userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, color: c.accent.primary }}>
          {/* CallSplit natively forks upward; rotated 90deg the fork
              points right, matching the Workflows brand mark. */}
          <CallSplitRoundedIcon sx={{ fontSize: 16, transform: 'rotate(90deg)' }} />
        </Box>
        <Typography sx={{ flex: 1, fontWeight: 700, fontSize: '0.88rem', color: c.text.primary }}>Workflows</Typography>
        <IconButton
          size="small"
          data-no-drag
          onClick={(e) => { e.stopPropagation(); dispatch(closeWorkflowsHub()); }}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ p: 0.35, color: c.text.ghost, '&:hover': { color: c.status.error, bgcolor: c.status.errorBg } }}
        >
          <CloseIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Box>

      {/* ===== Toolbar row (matches Figma image #8 header) ===== */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.65, px: 1.5, py: 0.55, bgcolor: c.bg.elevated, borderBottom: `1px solid ${c.border.subtle}`, flexShrink: 0 }}>
        <Tooltip title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
          <IconButton size="small" data-no-drag onClick={() => setSidebarOpen((v) => !v)} sx={{ p: 0.5, color: sidebarOpen ? c.text.secondary : c.text.muted, '&:hover': { color: c.text.primary } }}>
            <MenuIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Box
          onClick={onNew}
          role="button"
          data-no-drag
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.4,
            fontSize: '0.85rem', fontWeight: 600, color: c.text.primary,
            bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`,
            px: 1, py: 0.4, borderRadius: `${c.radius.md}px`, cursor: 'pointer',
            '&:hover': { borderColor: c.accent.primary, color: c.accent.primary },
          }}
        >
          New
        </Box>
        <Tooltip title={paused ? 'Scheduled runs are paused. In-flight runs will finish; new fires are blocked until you resume.' : 'Stop all future scheduled runs without disabling them one-by-one. Any run already in flight will finish.'}>
          <Box
            onClick={togglePaused}
            role="button"
            data-no-drag
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.4, ml: 0.5,
              fontSize: '0.8rem', fontWeight: 600,
              color: paused ? c.status.warning || c.accent.primary : c.text.secondary,
              bgcolor: paused ? (c.status.warningBg || c.bg.elevated) : 'transparent',
              border: `1px solid ${paused ? (c.status.warning || c.accent.primary) + '60' : c.border.subtle}`,
              px: 0.85, py: 0.3, borderRadius: `${c.radius.md}px`, cursor: 'pointer',
              '&:hover': { color: c.text.primary, borderColor: c.border.medium },
            }}>
            <Switch size="small" checked={paused} sx={{ pointerEvents: 'none', mr: -0.5, ml: -0.5 }} />
            <span>{paused ? 'Paused' : 'Pause all'}</span>
          </Box>
        </Tooltip>

        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.75 }}>
          <Box
            onClick={() => setRefDate(new Date())}
            role="button"
            data-no-drag
            sx={{
              fontSize: '0.82rem', fontWeight: 500, color: c.text.secondary,
              border: `1px solid ${c.border.subtle}`,
              px: 1.1, py: 0.35, borderRadius: `${c.radius.md}px`, cursor: 'pointer',
              '&:hover': { color: c.text.primary, borderColor: c.border.medium },
            }}>Today</Box>
          <IconButton size="small" data-no-drag onClick={() => setRefDate(addDays(refDate, view === 'Month' ? -28 : -7))} sx={{ p: 0.3 }}><ChevronLeftIcon sx={{ fontSize: 18 }} /></IconButton>
          <IconButton size="small" data-no-drag onClick={() => setRefDate(addDays(refDate, view === 'Month' ? 28 : 7))} sx={{ p: 0.3 }}><ChevronRightIcon sx={{ fontSize: 18 }} /></IconButton>
          <Typography sx={{ fontSize: '0.92rem', fontWeight: 600, color: c.text.primary }}>{monthLabel}</Typography>
          <TimeSavedBadge />
        </Box>

        <Box sx={{ position: 'relative' }}>
          <Box
            onClick={() => setViewOpen((v) => !v)}
            role="button"
            data-no-drag
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.25,
              fontSize: '0.82rem', fontWeight: 500, color: c.text.secondary,
              border: `1px solid ${c.border.subtle}`, px: 1, py: 0.35,
              borderRadius: `${c.radius.md}px`, cursor: 'pointer',
              '&:hover': { color: c.text.primary, borderColor: c.border.medium },
            }}>
            {view}
            <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />
          </Box>
          {viewOpen && (
            <Box sx={{ position: 'absolute', top: '100%', right: 0, mt: 0.5, bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, boxShadow: c.shadow.md, zIndex: 5, minWidth: 110 }}>
              {(['List', 'Week', 'Month'] as const).map((v) => (
                <Box
                  key={v}
                  data-no-drag
                  onClick={() => { setView(v); setViewOpen(false); }}
                  sx={{ px: 1.25, py: 0.65, fontSize: '0.85rem', color: view === v ? c.accent.primary : c.text.primary, fontWeight: view === v ? 600 : 400, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
                  {v}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      {/* ===== Body: sidebar + main calendar ===== */}
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Sidebar */}
        {sidebarOpen && (
        <Box sx={{ width: 210, flexShrink: 0, bgcolor: c.bg.elevated, borderRight: `1px solid ${c.border.subtle}`, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ px: 1.25, pt: 1, pb: 0.6 }}>
            <InputBase
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search workflows"
              startAdornment={<SearchIcon sx={{ fontSize: 16, color: c.text.muted, mr: 0.75 }} />}
              sx={{ fontSize: '0.82rem', color: c.text.primary, width: '100%', '& input::placeholder': { color: c.text.ghost, opacity: 1 } }}
            />
          </Box>
          <MiniMonth refDate={refDate} onPick={setRefDate} />
          <Box sx={{ flex: 1, overflowY: 'auto', px: 1.25, pb: 1.25 }}>
            <SidebarSection title="Scheduled" items={scheduled.filter((w) => match(w.title, search))} onPick={onSelectWorkflow} scheduled onContext={(wf, e) => setSidebarCtxMenu({ x: e.clientX, y: e.clientY, workflow: wf })} />
            <SidebarSection title="Unscheduled" items={unscheduled.filter((w) => match(w.title, search))} onPick={onSelectWorkflow} scheduled={false} onContext={(wf, e) => setSidebarCtxMenu({ x: e.clientX, y: e.clientY, workflow: wf })} onSchedule={(wf, el) => setSchedulePopover({ anchorEl: el, workflow: wf })} />
          </Box>
        </Box>
        )}

        {/* Main calendar area */}
        <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto', p: 1.25, bgcolor: c.bg.surface }}>
          <ScheduleCalendar view={view} density="roomy" onSelectWorkflow={onSelectWorkflow} refDate={refDate} />
        </Box>
      </Box>

      {/* Right-click menu shared across all sidebar workflow rows */}
      <Menu
        open={Boolean(sidebarCtxMenu)}
        onClose={closeSidebarCtxMenu}
        anchorReference="anchorPosition"
        anchorPosition={sidebarCtxMenu ? { top: sidebarCtxMenu.y, left: sidebarCtxMenu.x } : undefined}>
        <MenuItem onClick={() => {
          if (!sidebarCtxMenu) return;
          dispatch(runWorkflowNow({
            id: sidebarCtxMenu.workflow.id,
            signature: stepsSignature(sidebarCtxMenu.workflow.steps),
          }));
          closeSidebarCtxMenu();
        }}>Run now</MenuItem>
        {sidebarCtxMenu && isWorkflowSchedulable(sidebarCtxMenu.workflow) && (
        <MenuItem onClick={() => {
          if (!sidebarCtxMenu) return;
          const wf = sidebarCtxMenu.workflow;
          dispatch(updateWorkflow({
            id: wf.id,
            patch: { schedule: { ...wf.schedule, enabled: !wf.schedule.enabled } as any },
            ifMatch: wf.updated_at || null,
          }));
          closeSidebarCtxMenu();
        }}>{sidebarCtxMenu.workflow.schedule.enabled ? 'Pause schedule' : 'Resume schedule'}</MenuItem>
        )}
        <MenuItem onClick={() => {
          if (!sidebarCtxMenu) return;
          dispatch(addWorkflowCard({ workflowId: sidebarCtxMenu.workflow.id }));
          dispatch(openWorkflowCard({ workflowId: sidebarCtxMenu.workflow.id, view: 'edit_agent' }));
          closeSidebarCtxMenu();
        }}>Edit…</MenuItem>
        <MenuItem
          onClick={() => {
            if (!sidebarCtxMenu) return;
            const ok = window.confirm(`Delete "${sidebarCtxMenu.workflow.title}"? Scheduled runs will stop.`);
            if (ok) dispatch(deleteWorkflow(sidebarCtxMenu.workflow.id));
            closeSidebarCtxMenu();
          }}
          sx={{ color: c.status.error }}>
          Delete
        </MenuItem>
      </Menu>

      {/* "+" on an Unscheduled row -> open the scheduler */}
      <AddToSchedulePopover
        anchorEl={schedulePopover?.anchorEl ?? null}
        workflow={schedulePopover?.workflow ?? null}
        onClose={closeSchedulePopover}
      />

      {/* Resize handles */}
      {HANDLE_DEFS.map(({ dir, sx }) => (
        <Box
          key={dir}
          className="resize-handle"
          onPointerDown={onResizeDown(dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          sx={{ position: 'absolute', cursor: CURSOR_MAP[dir], opacity: 0, zIndex: 25, ...sx }}
        />
      ))}
    </Box>
  );
};

function MiniMonth({ refDate, onPick }: { refDate: Date; onPick: (d: Date) => void }) {
  const c = useClaudeTokens();
  const start = startOfMonthGrid(refDate);
  const cells = Array.from({ length: 35 }, (_, i) => addDays(start, i));
  const today = new Date();
  const label = refDate.toLocaleString('en', { month: 'long', year: 'numeric' });
  return (
    <Box sx={{ px: 1.25, pb: 0.75, borderBottom: `1px solid ${c.border.subtle}` }}>
      <Box sx={{ display: 'flex', alignItems: 'center', py: 0.5 }}>
        <Typography sx={{ flex: 1, fontSize: '0.82rem', fontWeight: 700, color: c.text.primary }}>{label}</Typography>
        <IconButton size="small" data-no-drag onClick={() => onPick(addMonths(refDate, -1))} sx={{ p: 0.15 }}><ChevronLeftIcon sx={{ fontSize: 14 }} /></IconButton>
        <IconButton size="small" data-no-drag onClick={() => onPick(addMonths(refDate, 1))} sx={{ p: 0.15 }}><ChevronRightIcon sx={{ fontSize: 14 }} /></IconButton>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {WEEKDAY_LABEL.map((l, i) => (
          <Typography key={`${l}-${i}`} sx={{ textAlign: 'center', fontSize: '0.66rem', color: c.text.muted, fontWeight: 600, py: 0.2 }}>{l}</Typography>
        ))}
        {cells.map((d) => {
          const isToday = sameDay(d, today);
          const inMonth = d.getMonth() === refDate.getMonth();
          const selected = sameDay(d, refDate);
          return (
            <Box key={d.toISOString()} onClick={() => onPick(d)} data-no-drag sx={{ textAlign: 'center', py: 0.2, opacity: inMonth ? 1 : 0.4, cursor: 'pointer' }}>
              <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', bgcolor: isToday ? c.accent.primary : selected ? c.accent.primary + '30' : 'transparent', color: isToday ? '#fff' : c.text.secondary, fontWeight: isToday ? 700 : 500, fontSize: '0.72rem' }}>{d.getDate()}</Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function SidebarSection({ title, items, onPick, scheduled, onContext, onSchedule }: {
  title: string;
  items: Workflow[];
  onPick: (id: string) => void;
  scheduled: boolean;
  onContext: (workflow: Workflow, e: React.MouseEvent) => void;
  // Only the Unscheduled section wires this: clicking the "+" opens the
  // schedule creation popover anchored to the icon.
  onSchedule?: (workflow: Workflow, anchorEl: HTMLElement) => void;
}) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const allPaused = useAppSelector((s) => s.workflows.paused);
  const [open, setOpen] = useState(true);

  const toggleEnabled = useCallback((wf: Workflow, e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(updateWorkflow({
      id: wf.id,
      patch: { schedule: { ...wf.schedule, enabled: !wf.schedule.enabled } as any },
      ifMatch: wf.updated_at || null,
    }));
  }, [dispatch]);

  return (
    <Box sx={{ mt: 1.5 }}>
      <Box
        onClick={() => setOpen((v) => !v)}
        role="button"
        data-no-drag
        sx={{ display: 'flex', alignItems: 'center', mb: 0.5, cursor: 'pointer', '&:hover .section-chev': { color: c.text.primary } }}>
        <Typography sx={{ flex: 1, fontSize: '0.78rem', fontWeight: 700, color: c.text.secondary }}>{title}</Typography>
        <KeyboardArrowDownIcon className="section-chev" sx={{ fontSize: 14, color: c.text.muted, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s ease' }} />
      </Box>
      {open && items.length === 0 && (
        <Typography sx={{ fontSize: '0.76rem', color: c.text.muted, fontStyle: 'italic', py: 0.5, pl: 0.5 }}>None yet</Typography>
      )}
      {open && items.map((w) => (
        <Box
          key={w.id}
          onClick={() => onPick(w.id)}
          onContextMenu={(e) => { e.preventDefault(); onContext(w, e); }}
          data-no-drag
          sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.4, pl: 0.5, color: c.text.primary, borderRadius: 0.5, cursor: 'pointer', '&:hover': { bgcolor: c.bg.elevated } }}>
          {scheduled ? (
            <Tooltip title={w.schedule.enabled ? 'Pause this schedule' : 'Resume this schedule'}>
              <Box
                onClick={(e) => toggleEnabled(w, e)}
                sx={{
                  width: 14, height: 14, borderRadius: '3px', flexShrink: 0,
                  border: `1.5px solid ${w.schedule.enabled ? c.accent.primary : c.border.medium}`,
                  bgcolor: w.schedule.enabled ? c.accent.primary : 'transparent',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 10, lineHeight: 1, fontWeight: 700,
                  cursor: 'pointer',
                  '&:hover': { borderColor: c.accent.primary },
                }}>
                {w.schedule.enabled ? '✓' : ''}
              </Box>
            </Tooltip>
          ) : (
            <Tooltip title="Add to schedule">
              <Box
                onClick={(e) => { e.stopPropagation(); onSchedule?.(w, e.currentTarget); }}
                sx={{
                  width: 16, height: 16, borderRadius: '4px', flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  color: c.text.muted, cursor: 'pointer',
                  '&:hover': { color: c.accent.primary, bgcolor: c.bg.elevated },
                }}>
                <AddIcon sx={{ fontSize: 13 }} />
              </Box>
            </Tooltip>
          )}
          {/* Retype the title letter-by-letter when it auto-renames, matching
              the workflow card. Gated on a real (non-placeholder) title so it
              never animates on first appearance or for already-named rows. */}
          <Typewriter value={w.title} enabled={isRealTitle(w.title)}>
            {(t) => (
              <Typography sx={{ flex: 1, fontSize: '0.82rem', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: scheduled && (!w.schedule.enabled || allPaused) ? 0.7 : 1 }}>{t}</Typography>
            )}
          </Typewriter>
          {scheduled && (!w.schedule.enabled || allPaused) && (
            <Box sx={{ flexShrink: 0, px: 0.6, py: 0.1, borderRadius: '3px', bgcolor: c.bg.elevated, color: c.text.muted, fontSize: '0.62rem', fontWeight: 600, lineHeight: 1.5, letterSpacing: '0.02em' }}>Paused</Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

function match(title: string, query: string): boolean {
  if (!query.trim()) return true;
  return title.toLowerCase().includes(query.trim().toLowerCase());
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

export default React.memo(WorkflowsHubCard);
