import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import CloseIcon from '@mui/icons-material/Close';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded';
import CodeRoundedIcon from '@mui/icons-material/CodeRounded';
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import AddIcon from '@mui/icons-material/Add';
import KeyboardArrowUpRounded from '@mui/icons-material/KeyboardArrowUpRounded';
import { Output, SERVE_BASE } from '@/shared/state/outputsSlice';
import { setViewCardPosition, setViewCardSize, setActiveViewCardId, recordClosedCard, addViewCard } from '@/shared/state/dashboardLayoutSlice';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { API_BASE, getAuthToken } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewPreview, { ViewPreviewHandle } from '@/app/pages/Views/ViewPreview';
import TerminalPanel, { TerminalLine } from '@/app/pages/Views/TerminalPanel';
import AppCodePanel from '@/app/pages/Views/AppCodePanel';
import HistoryPanel from '@/app/pages/Views/HistoryPanel';
import ShareButton from '@/app/components/share/ShareButton';
import { getDefault } from '@/shared/inputSchemaDefaults';
import { useOverlayScrollPassthrough } from '../hooks/interaction/useOverlayScrollPassthrough';
import {
  useRuntimePreviewUrl,
  pickPreviewUrl,
  RuntimeLogLine,
} from '@/shared/hooks/useRuntimePreviewUrl';
import { postAppConsoleLine, terminalLineFromStream } from '@/shared/appTerminal';

type AppCardView = 'preview' | 'code' | 'terminal' | 'history';

const TERMINAL_BUFFER_CAP = 5000;

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;
const MIN_W = 320;
const MIN_H = 200;

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
  output: Output;
  // Record key in dashboardLayout.viewCards (output.id for the primary, `${output.id}#N` for extras); every layout/selection dispatch keys by this.
  cardKey?: string;
  // Which independent instance of the app this card runs; each instance gets its own runtime + ports.
  instance?: number;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  cmdHeld?: boolean;
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  cardZOrder?: number;
  onDoubleClick?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
}

// The app card's loading state while its runtime spins up. One soft pulse, calm copy, and an honest hint only after 9s, a freshly-imported app installs its deps on first open, which is the slow case worth explaining instead of leaving the user staring at a dead screen.
const BootingBody: React.FC = () => {
  const c = useClaudeTokens();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 9000);
    return () => clearTimeout(t);
  }, []);
  return (
    <Box
      sx={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 1.25, px: 3, textAlign: 'center',
      }}
    >
      <Box
        sx={{
          width: 7, height: 7, borderRadius: '50%', bgcolor: c.accent.primary,
          animation: 'osBootPulse 1.4s ease-in-out infinite',
          '@keyframes osBootPulse': {
            '0%, 100%': { opacity: 0.35, transform: 'scale(0.8)' },
            '50%': { opacity: 1, transform: 'scale(1)' },
          },
        }}
      />
      <Typography sx={{ fontSize: '0.85rem', color: c.text.muted }}>Starting preview</Typography>
      <Fade in={slow} timeout={400} unmountOnExit>
        <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, maxWidth: 240 }}>
          First run sets the app up, this can take a moment.
        </Typography>
      </Fade>
    </Box>
  );
};

const DashboardViewCard: React.FC<Props> = ({
  output, cardKey: cardKeyProp, instance = 1, cardX, cardY, cardWidth, cardHeight, getCanvasState, cmdHeld = false,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  cardZOrder = 0, onDoubleClick, onBringToFront,
}) => {
  const cardKey = cardKeyProp ?? output.id;
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);
  const previewRef = useRef<ViewPreviewHandle>(null);
  const activeViewCardId = useAppSelector((s) => s.dashboardLayout.activeViewCardId);
  const interactive = activeViewCardId === cardKey;

  // Deselecting the card exits interact mode (click anywhere else on canvas).
  useEffect(() => {
    if (!isSelected && interactive) dispatch(setActiveViewCardId(null));
  }, [isSelected, interactive, dispatch]);

  // Escape exits interact mode.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch(setActiveViewCardId(null));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactive, dispatch]);

  const [inputData] = useState<Record<string, any>>(() => getDefault(output.input_schema));
  const [backendResult] = useState<Record<string, any> | null>(null);

  // Preview/Code/Terminal switcher; only new-mode (workspace-backed) apps have code + terminal to show.
  const [activeView, setActiveView] = useState<AppCardView>('preview');
  const hasWorkspace = !!output.workspace_id;
  // Chevron rolls the whole header away so an immersive app fills the card; hovering the top edge peeks it back.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [headerPeek, setHeaderPeek] = useState(false);
  const showControls = !headerCollapsed || headerPeek;
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const terminalLineIdRef = useRef(0);
  // Fed by the runtime logs WS (which replays its ring buffer on connect); frontend console lines arrive on the same socket via the console-log beacon echo.
  const handleRuntimeLog = useCallback((line: RuntimeLogLine) => {
    const fields = terminalLineFromStream(line.stream, line.text);
    setTerminalLines((prev) => {
      const next = prev.concat({ id: ++terminalLineIdRef.current, ...fields });
      return next.length > TERMINAL_BUFFER_CAP ? next.slice(next.length - TERMINAL_BUFFER_CAP) : next;
    });
  }, []);

  // Reload the preview when the session finishes a turn: React holds the ErrorBoundary's snag page until a reload, so without this the user keeps seeing the old error even after the agent fixed it. The overlay lingers through the reload (finishing) so the stale page never flashes.
  const linkedStatus = useAppSelector(
    (s) => (output.session_id ? s.agents.sessions[output.session_id]?.status : undefined),
  );
  const [finishing, setFinishing] = useState(false);
  const wasBuildingRef = useRef(false);
  const finishTimerRef = useRef<number | null>(null);
  // Whether this turn changed deps (needs a Vite restart, not just a soft reload). Held in a ref so the reload effect stays keyed on the status transition alone.
  const depsChanged = useAppSelector(
    (s) => (output.session_id ? !!s.agents.sessions[output.session_id]?.app_deps_changed : false),
  );
  const depsChangedRef = useRef(false);
  useEffect(() => { depsChangedRef.current = depsChanged; }, [depsChanged]);
  useEffect(() => {
    const building = linkedStatus === 'running' || linkedStatus === 'waiting_approval';
    if (wasBuildingRef.current && !building) {
      const wsId = output.workspace_id;
      if (depsChangedRef.current && wsId) {
        // Deps changed this turn: a soft reload can't pick up new packages, so restart the Vite runtime first, then reload.
        void (async () => {
          try {
            const tok = getAuthToken();
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (tok) headers.Authorization = `Bearer ${tok}`;
            await fetch(`${API_BASE}/outputs/workspace/${wsId}/runtime/restart?instance=${instance}`, { method: 'POST', headers });
          } catch { /* failures surface via the runtime log WS */ }
          previewRef.current?.reload();
        })();
      } else {
        previewRef.current?.reload();
      }
      setFinishing(true);
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
      finishTimerRef.current = window.setTimeout(() => setFinishing(false), 1200);
    }
    wasBuildingRef.current = building;
  }, [linkedStatus]);
  useEffect(() => () => {
    if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
  }, []);
  const showBuildingOverlay = linkedStatus === 'running'
    || linkedStatus === 'waiting_approval' || finishing;

  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });


  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getCanvasState();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY, startPanX: cs.panX, startPanY: cs.panY };
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(cardKey, 'view');
  }, [cardX, cardY, onDragStart, cardKey, getCanvasState]);

  const recomputeDragPos = useCallback(() => {
    const ds = dragState.current;
    if (!ds || !didDrag.current) return;
    const { clientX, clientY } = lastPointerRef.current;
    const rawDx = clientX - ds.startX;
    const rawDy = clientY - ds.startY;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - ds.startPanX) / z;
    const panDy = (cs.panY - ds.startPanY) / z;
    const dx = rawDx / z - panDx;
    const dy = rawDy / z - panDy;
    setLocalDragPos({ x: ds.origX + dx, y: ds.origY + dy });
    onDragMove?.(dx, dy, clientX, clientY);
  }, [onDragMove, getCanvasState]);

  // Edge-pan/wheel-zoom moves the camera without a React commit; the pan-changed event is the live signal to re-pin the card to the cursor.
  useEffect(() => {
    if (!isDragging) return;
    const onPanChange = () => {
      if (didDrag.current) recomputeDragPos();
    };
    window.addEventListener('openswarm:canvas-pan-changed', onPanChange);
    return () => window.removeEventListener('openswarm:canvas-pan-changed', onPanChange);
  }, [isDragging, recomputeDragPos]);

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
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = (e.clientX - dragState.current.startX) / z - panDx;
    const dy = (e.clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;
      // Snap to 24px grid; Shift bypasses.
      if (!e.shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }
      dispatch(setViewCardPosition({
        outputId: cardKey,
        x: finalX,
        y: finalY,
      }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, cardKey, onDragEnd, getCanvasState]);

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
      const zoom = getCanvasState().zoom;
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
    [getCanvasState],
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
      dispatch(setViewCardPosition({ outputId: cardKey, x: result.x, y: result.y }));
      dispatch(setViewCardSize({ outputId: cardKey, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, cardKey]);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(recordClosedCard({ kind: 'view', id: cardKey }));
    void removeViewCardCleanly(cardKey, dispatch);
  };

  // Spawn ANOTHER independent instance of this app (own runtime + ports); the reducer picks the next #N and the lifecycle hook fits + highlights it.
  const handleOpenAnother = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch(addViewCard({ outputId: output.id, newInstance: true }));
  };

  const [reloadMenuRect, setReloadMenuRect] = useState<DOMRect | null>(null);
  const handleHardReload = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setReloadMenuRect(null);
    const wsId = output.workspace_id;
    if (wsId) {
      try {
        const tok = getAuthToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tok) headers.Authorization = `Bearer ${tok}`;
        await fetch(`${API_BASE}/outputs/workspace/${wsId}/runtime/restart?instance=${instance}`, {
          method: 'POST',
          headers,
        });
      } catch { /* failures surface via the runtime log WS */ }
    }
    previewRef.current?.reload();
  }, [output.workspace_id, instance]);

  // In Terminal view a soft webview reload is invisible (the terminal is what you're looking at), so the refresh button always hard-reloads there.
  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeView === 'terminal' && output.workspace_id) {
      void handleHardReload(e);
      return;
    }
    previewRef.current?.reload();
  };

  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const displayX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const displayY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const displayW = localResize?.w ?? cardWidth;
  const displayH = localResize?.h ?? cardHeight;
  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);
  // Drag via a compositor transform, not left/top: an app card's webview surface shimmers back and forth while edge-panning otherwise (the transform and the late left/top relayout desync a frame). Same fix as BrowserCard.
  const dragging = isDragging && !!localDragPos && !localResize;
  const dragTx = dragging ? displayX - cardX : 0;
  const dragTy = dragging ? displayY - cardY : 0;

  return (
    <Box
      data-select-type="view-card"
      data-select-id={cardKey}
      data-select-meta={JSON.stringify({ name: output.name, description: output.description, path: output.workspace_path })}
      onPointerDownCapture={() => onBringToFront?.(cardKey, 'view')}
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(cardKey, 'view', e.shiftKey);
      }}
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onDoubleClick?.(cardKey, 'view');
      }}
      sx={{
        position: 'absolute',
        // contain + willChange: own compositor layer so paint stays scoped (see AgentCard for full rationale).
        contain: 'layout style',
        willChange: 'transform',
        left: dragging ? cardX : displayX,
        top: dragging ? cardY : displayY,
        transform: dragging ? `translate3d(${dragTx}px, ${dragTy}px, 0)` : undefined,
        width: displayW,
        height: displayH,
        borderRadius: `${c.radius.lg}px`,
        border: isHighlighted
          ? `2px solid ${c.accent.primary}`
          : interactive
            ? `2px solid ${c.accent.primary}`
            : isSelected ? '2px solid #3b82f6' : `1px solid ${c.border.medium}`,
        bgcolor: c.bg.surface,
        boxShadow: isHighlighted
          ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
          : isDragging || isResizing
            ? c.shadow.lg
            : isSelected
              ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
              : c.shadow.md,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: (isDragging || isResizing) ? 999999 : cardZOrder,
        transition: noTransition ? 'none' : 'box-shadow 0.2s',
        '&:hover .resize-handle': { opacity: 1 },
        ...(isHighlighted && {
          animation: 'card-highlight-pulse 2s ease-out forwards',
          '@keyframes card-highlight-pulse': {
            '0%': {
              boxShadow: `0 0 0 3px ${c.accent.primary}70, 0 0 24px ${c.accent.primary}50, 0 0 48px ${c.accent.primary}25`,
            },
            '25%': {
              boxShadow: `0 0 0 4px ${c.accent.primary}55, 0 0 30px ${c.accent.primary}40, 0 0 56px ${c.accent.primary}20`,
            },
            '50%': {
              boxShadow: `0 0 0 3px ${c.accent.primary}45, 0 0 22px ${c.accent.primary}30, 0 0 44px ${c.accent.primary}15`,
            },
            '75%': {
              boxShadow: `0 0 0 2px ${c.accent.primary}25, 0 0 14px ${c.accent.primary}18, 0 0 28px ${c.accent.primary}08`,
            },
            '100%': {
              boxShadow: c.shadow.md,
            },
          },
        }),
      }}
    >
      {/* No full-card overlay: it blocked pointer events to the live app. Drag uses the header (zIndex 16); ref kept as a no-op for useOverlayScrollPassthrough. */}
      <Box
        ref={scrollOverlayRef}
        sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}
      />

      {/* When collapsed, a thin invisible strip at the very top peeks the header back on hover (fullscreen-video pattern). */}
      {headerCollapsed && (
        <Box
          onPointerEnter={() => setHeaderPeek(true)}
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 16, zIndex: 15 }}
        />
      )}

      {/* Header */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerEnter={() => { if (headerCollapsed) setHeaderPeek(true); }}
        onPointerLeave={() => setHeaderPeek(false)}
        sx={{
          position: headerCollapsed ? 'absolute' : 'relative',
          top: headerCollapsed ? 0 : undefined,
          left: headerCollapsed ? 0 : undefined,
          right: headerCollapsed ? 0 : undefined,
          transform: headerCollapsed && !headerPeek ? 'translateY(-110%)' : 'translateY(0)',
          transition: 'transform 0.18s ease',
          zIndex: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.5,
          py: 0.75,
          bgcolor: c.bg.secondary,
          borderBottom: `1px solid ${c.border.subtle}`,
          cursor: isDragging ? 'grabbing' : 'grab',
          flexShrink: 0,
          minHeight: 36,
          userSelect: 'none',
        }}
      >
        <GridViewRoundedIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
        <Typography
          sx={{
            flex: 1,
            fontSize: '0.8rem',
            fontWeight: 600,
            color: c.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {output.name}
        </Typography>
        {instance > 1 && (
          <Typography sx={{ fontSize: '0.66rem', fontWeight: 700, color: c.text.ghost, bgcolor: c.bg.page, borderRadius: 999, px: 0.75, py: 0.1, flexShrink: 0 }}>
            #{instance}
          </Typography>
        )}

        {showControls && (
          <>
            {hasWorkspace && (
              <Box
                onPointerDown={(e) => e.stopPropagation()}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.25,
                  bgcolor: c.bg.page,
                  borderRadius: 999,
                  p: 0.25,
                  flexShrink: 0,
                }}
              >
                {([
                  { view: 'preview' as const, label: 'Preview', Icon: VisibilityRoundedIcon },
                  { view: 'code' as const, label: 'Code', Icon: CodeRoundedIcon },
                  { view: 'terminal' as const, label: 'Terminal', Icon: TerminalRoundedIcon },
                  { view: 'history' as const, label: 'History', Icon: HistoryRoundedIcon },
                ]).map(({ view, label, Icon }) => (
                  <Tooltip key={view} title={label} placement="top">
                    <IconButton
                      size="small"
                      onClick={(e) => { e.stopPropagation(); setActiveView(view); }}
                      sx={{
                        p: 0.5,
                        borderRadius: 999,
                        color: activeView === view ? c.text.primary : c.text.ghost,
                        bgcolor: activeView === view ? c.bg.elevated : 'transparent',
                        '&:hover': { color: c.text.primary, bgcolor: activeView === view ? c.bg.elevated : `${c.text.primary}0a` },
                      }}
                    >
                      <Icon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                ))}
              </Box>
            )}

            <Box onPointerDown={(e) => e.stopPropagation()} sx={{ display: 'flex', flexShrink: 0 }}>
              <ShareButton target={{ kind: 'app', id: output.id, name: output.name }} size="small" iconFontSize={15} />
            </Box>

            <Tooltip
              title={activeView === 'terminal' ? 'Hard reload (restart runtime + reload app)' : 'Reload preview; right-click for Hard Reload'}
              placement="top"
            >
              <IconButton
                size="small"
                onClick={handleRefresh}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!output.workspace_id) return;
                  setReloadMenuRect((e.currentTarget as HTMLElement).getBoundingClientRect());
                }}
                onPointerDown={(e) => e.stopPropagation()}
                sx={{ color: c.text.muted, p: 0.5, '&:hover': { color: c.text.primary } }}
              >
                <RefreshIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>

            {hasWorkspace && (
              <Tooltip title="Open another window" placement="top">
                <IconButton
                  size="small"
                  onClick={handleOpenAnother}
                  onPointerDown={(e) => e.stopPropagation()}
                  sx={{ color: c.text.ghost, p: 0.5, '&:hover': { color: c.text.primary } }}
                >
                  <AddIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </>
        )}

        <Tooltip title={headerCollapsed ? 'Show toolbar' : 'Hide toolbar'} placement="top">
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); setHeaderPeek(false); setHeaderCollapsed((v) => !v); }}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.ghost, p: 0.5, '&:hover': { color: c.text.primary } }}
          >
            <KeyboardArrowUpRounded sx={{ fontSize: 18, transition: 'transform 0.15s', transform: headerCollapsed ? 'rotate(180deg)' : 'none' }} />
          </IconButton>
        </Tooltip>

        <Tooltip title="Remove from dashboard" placement="top">
          <IconButton
            size="small"
            onClick={handleRemove}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.ghost, p: 0.5, '&:hover': { color: c.status.error } }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Preview body */}
      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {cmdHeld && !isSelected && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 12 }} />
        )}
        <DashboardOutputPreview
          previewRef={previewRef}
          output={output}
          cardKey={cardKey}
          instance={instance}
          inputData={inputData}
          backendResult={backendResult}
          interactive={interactive}
          onAppClicked={() => dispatch(setActiveViewCardId(cardKey))}
          onRuntimeLog={handleRuntimeLog}
        />
        {/* Code/Terminal overlay the always-mounted preview instead of replacing it: unmounting the webview kills the app's live state and forces a reload on switch-back. */}
        {output.workspace_id && activeView !== 'preview' && (
          <Box sx={{ position: 'absolute', inset: 0, zIndex: 13, bgcolor: c.bg.surface }}>
            {activeView === 'terminal' ? (
              <TerminalPanel lines={terminalLines} />
            ) : activeView === 'history' ? (
              <Box sx={{ height: '100%', overflow: 'auto' }}>
                <HistoryPanel
                  outputId={output.id}
                  isAgentActive={showBuildingOverlay}
                  onRestored={() => previewRef.current?.reload()}
                />
              </Box>
            ) : (
              <AppCodePanel workspaceId={output.workspace_id} onFileSaved={() => previewRef.current?.reload()} />
            )}
          </Box>
        )}
        <BuildingOverlay show={showBuildingOverlay && activeView === 'preview'} />
      </Box>

      {/* Resize handles */}
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
            zIndex: 10,
            ...sx,
          }}
        />
      ))}

      {/* Custom popover: MUI Menu's Popover machinery fought the canvas transform + Electron webview compositor, so this is plain position:fixed JSX. Floats above the icon into empty canvas, never overlaps the webview. */}
      {reloadMenuRect && createPortal(
        <>
          <Box
            onClick={() => setReloadMenuRect(null)}
            onContextMenu={(e) => { e.preventDefault(); setReloadMenuRect(null); }}
            sx={{ position: 'fixed', inset: 0, zIndex: 2147483646 }}
          />
          <Box
            sx={{
              position: 'fixed',
              bottom: window.innerHeight - reloadMenuRect.top + 6,
              right: window.innerWidth - reloadMenuRect.right,
              zIndex: 2147483647,
              bgcolor: c.bg.elevated,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: `${c.radius.md}px`,
              boxShadow: c.shadow.lg,
              minWidth: 260,
              py: 0.5,
            }}
          >
            <Box
              onClick={handleHardReload}
              sx={{
                px: 1.5, py: 1,
                display: 'flex',
                gap: 1.25,
                alignItems: 'center',
                cursor: 'pointer',
                transition: 'background-color 0.12s',
                '&:hover': { bgcolor: c.bg.surface },
              }}
            >
              <RestartAltIcon sx={{ fontSize: 18, color: c.text.muted, flexShrink: 0 }} />
              <Box>
                <Typography sx={{ fontSize: '0.82rem', fontWeight: 500, color: c.text.primary, lineHeight: 1.2 }}>
                  Reset & Hard Reload
                </Typography>
                <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, mt: 0.25 }}>
                  Restart backend.py + reload preview
                </Typography>
              </Box>
            </Box>
          </Box>
        </>,
        document.body,
      )}
    </Box>
  );
};

export default React.memo(DashboardViewCard);

// Calm overlay shown while the App Builder chat that owns this output is actively editing it (and through the post-turn reload). Hides whatever transient half-broken state the agent might be writing through so the user sees "Building..." instead of an error iframe. Fades in/out.
const BuildingOverlay: React.FC<{ show: boolean }> = ({ show }) => {
  const c = useClaudeTokens();
  return (
    <Fade in={show} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 11,
          bgcolor: c.bg.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.25,
          // Block pointer events to the iframe behind so user can't click into the half-built app.
          pointerEvents: 'auto',
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: c.accent.primary,
            animation: 'view-card-building-pulse 1.2s ease-in-out infinite',
            '@keyframes view-card-building-pulse': {
              '0%, 100%': { opacity: 0.35, transform: 'scale(0.85)' },
              '50%': { opacity: 1, transform: 'scale(1)' },
            },
          }}
        />
        <Typography sx={{ color: c.text.secondary, fontSize: '0.85rem', fontWeight: 500 }}>
          Building…
        </Typography>
      </Box>
    </Fade>
  );
};

// Old-mode outputs render the legacy serve URL; new-mode webapp_template outputs attach to a runtime and point the webview at Vite once frontend_url arrives.
const DashboardOutputPreview: React.FC<{
  previewRef: React.Ref<ViewPreviewHandle>;
  output: Output;
  cardKey?: string;
  instance?: number;
  inputData: Record<string, any>;
  backendResult: any;
  interactive: boolean;
  onAppClicked: () => void;
  onRuntimeLog?: (line: RuntimeLogLine) => void;
}> = ({ previewRef, output, cardKey, instance = 1, inputData, backendResult, interactive, onAppClicked, onRuntimeLog }) => {
  const tokens = useClaudeTokens();
  const dispatch = useAppDispatch();
  const workspaceId = output.workspace_id ?? null;
  const { frontendUrl, isNewMode, isHydrating } = useRuntimePreviewUrl({
    workspaceId,
    enabled: !!workspaceId,
    onLog: onRuntimeLog,
    instance,
  });
  const { url, isBooting } = pickPreviewUrl({
    workspaceId,
    legacyUrl: `${SERVE_BASE}/${output.id}/serve/index.html`,
    frontendUrl,
    isNewMode,
  });

  // Declared above every early-return below so React's hook order stays stable; moving it below would trigger "Rendered more hooks than during the previous render."
  const handleConsoleMessage = useCallback((level: string, text: string) => {
    if (!text || !workspaceId) return;
    const tok = getAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (text.includes('[openswarm:app-ready]')) {
      fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/report-ready?instance=${instance}`, {
        method: 'POST', headers,
      }).catch(() => {});
      return;
    }
    // Fold console output into the runtime terminal stream (card Terminal view + agent-readable terminal.log).
    postAppConsoleLine(workspaceId, level, text, instance);
    if (level !== 'error' || !text.includes('[openswarm:app-error]')) return;
    const idx = text.indexOf('[openswarm:app-error]');
    const tail = text.slice(idx + '[openswarm:app-error]'.length).trim();
    const firstNewline = tail.indexOf('\n');
    const message = firstNewline >= 0 ? tail.slice(0, firstNewline).trim() : tail;
    const componentStack = firstNewline >= 0 ? tail.slice(firstNewline + 1).trim() : '';
    fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/report-error?instance=${instance}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, componentStack }),
    }).catch(() => {});
  }, [workspaceId, instance]);

  // An orphaned record (files deleted on disk) used to render the raw 404 JSON inside the card, or spin on "Starting preview" forever; probe once instead.
  const [filesMissing, setFilesMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const tok = getAuthToken();
    const headers: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
    const probe = workspaceId
      ? `${API_BASE}/outputs/workspace/${workspaceId}`
      : `${SERVE_BASE}/${output.id}/serve/index.html`;
    fetch(probe, { headers })
      .then((r) => {
        if (!cancelled && r.status === 404) setFilesMissing(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workspaceId, output.id]);

  if (filesMissing) {
    return (
      <Box
        sx={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          px: 2,
          textAlign: 'center',
        }}
      >
        <Typography sx={{ color: tokens.text.secondary, fontSize: '0.9rem' }}>
          This app's files are missing.
        </Typography>
        <Typography
          onClick={() => void removeViewCardCleanly(cardKey ?? output.id, dispatch)}
          sx={{
            color: tokens.accent.primary,
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          Remove card
        </Typography>
      </Box>
    );
  }

  // Blank body during hydration so warm runtimes don't flash "Starting preview..."
  if (isHydrating && !frontendUrl) {
    return <Box sx={{ width: '100%', height: '100%' }} />;
  }

  if (isBooting) {
    return <BootingBody />;
  }

  return (
    <ViewPreview
      ref={previewRef}
      registryId={cardKey ?? output.id}
      serveUrl={url}
      frontendCode={output.files?.['index.html'] ?? ''}
      inputData={inputData}
      backendResult={backendResult}
      onConsoleMessage={handleConsoleMessage}
      interactive={interactive}
      onAppClicked={onAppClicked}
      agentBrowserId={instance > 1 ? `app:${output.id}#${instance}` : `app:${output.id}`}
    />
  );
};
