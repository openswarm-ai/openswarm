import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import CheckIcon from '@mui/icons-material/Check';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import TerminalIcon from '@mui/icons-material/Terminal';
import { motion } from 'framer-motion';
import {
  AgentSession,
  handleApproval,
  collapseSession,
  closeSession,
} from '@/shared/state/agentsSlice';
import {
  setCardPosition,
  setCardSize,
  fadeGlowingAgentCard,
  clearGlowingAgentCard,
  removeCard,
} from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { QuestionForm } from '@/app/pages/AgentChat/shell/ApprovalBar';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import { parseMcpToolName, getMcpShortAction } from '@/shared/mcpToolMeta';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useDashboardActive } from '@/shared/hooks/useDashboardActive';
import { useOverlayScrollPassthrough } from '../hooks/interaction/useOverlayScrollPassthrough';
import { useStreamingMessage } from '@/shared/state/streamingSlice';
import { isCanvasInteractionActive, onCanvasInteractionEnd } from '@/shared/canvasInteractionState';

// ---------------------------------------------------------------------------
// Helper components & functions (unchanged)
// ---------------------------------------------------------------------------

const GoogleServiceIcon: React.FC<{ service: string; size?: number }> = ({ service, size = 16 }) => {
  if (service === 'gmail') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <path d="M2 6.5V18a2 2 0 002 2h1V8l-3-1.5z" fill="#4285F4"/>
        <path d="M22 6.5V18a2 2 0 01-2 2h-1V8l3-1.5z" fill="#34A853"/>
        <path d="M5 8v12h2V10.2L12 14l5-3.8V20h2V8l-7 5.25L5 8z" fill="#EA4335"/>
        <path d="M4 4a2 2 0 00-2 2.5L5 8V4H4z" fill="#4285F4"/>
        <path d="M20 4a2 2 0 012 2.5L19 8V4h1z" fill="#FBBC04"/>
        <path d="M19 4H5v4l7 5.25L19 8V4z" fill="#EA4335"/>
      </svg>
    );
  }
  if (service === 'calendar') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="2" fill="#fff" stroke="#4285F4" strokeWidth="1.5"/>
        <rect x="3" y="3" width="18" height="6" rx="2" fill="#4285F4"/>
        <text x="12" y="17.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#4285F4" fontFamily="sans-serif">31</text>
      </svg>
    );
  }
  if (service === 'drive' || service === 'sheets') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <path d="M8 2l7 12H1L8 2z" fill="#FBBC04"/>
        <path d="M15 2l7 12h-7L8 2h7z" fill="#34A853"/>
        <path d="M1 14h14l-3.5 6H4.5L1 14z" fill="#4285F4"/>
        <path d="M15 14h7l-3.5 6h-7L15 14z" fill="#EA4335"/>
      </svg>
    );
  }
  return null;
};

function fmtSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Self-ticking elapsed-time renderer. Owns its own 1Hz interval so only
// this leaf re-renders per second while a session is active; the rest
// of AgentCard stays put. Memoized on `status` + `messages` so it
// doesn't re-tick after the session goes terminal.
const ElapsedTimer: React.FC<{
  messages: Array<{ role: string; timestamp: string; elapsed_ms?: number; hidden?: boolean }>;
  status: string;
}> = React.memo(({ messages, status }) => {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (status !== 'running' && status !== 'waiting_approval') return;
    const id = setInterval(() => setTick((t) => (t + 1) & 0xffff), 1000);
    return () => clearInterval(id);
  }, [status]);
  return <>{fmtSeconds(getAgentWorkTime(messages, status).last)}</>;
});

function getAgentWorkTime(
  messages: Array<{ role: string; timestamp: string; elapsed_ms?: number; hidden?: boolean }>,
  status: string,
): { total: number; last: number } {
  // True wall-clock duration: how long the user actually waited, from
  // their prompt to the LAST assistant/system message of that turn.
  // Covers thinking + every tool call + assistant text generation +
  // any subagent/MCP work , anything that consumed user attention.
  //
  // This is intentionally NOT the sum of `thinking.elapsed_ms` (which
  // would cover only reasoning time and miss tool execution). The
  // thinking pill in the chat already exposes reasoning-only as a
  // distinct signal; the header timer's job is to answer "how long
  // did this take?" which is a different question.
  //
  // For each user message we find the LAST adjacent assistant/system
  // message before the next user message , that's the turn boundary.
  // If the turn is still in flight (last user message has no assistant
  // reply yet AND session is running/waiting), extrapolate to now so
  // the timer ticks live.
  //
  // Hidden messages (auto-continuation prompts from MCPActivate, etc.)
  // are skipped , they're system-internal turns the user didn't see
  // and shouldn't be billed for.
  const visible = messages.filter((m) => !m.hidden);
  let totalMs = 0;
  let lastMs = 0;
  for (let i = 0; i < visible.length; i++) {
    const msg = visible[i];
    if (msg.role !== 'user') continue;

    // Find the bounds of this turn: from this user message to just
    // before the next user message (or end of array).
    let nextUserIdx = visible.length;
    for (let k = i + 1; k < visible.length; k++) {
      if (visible[k].role === 'user') {
        nextUserIdx = k;
        break;
      }
    }

    // Last assistant/system message before the next user message =
    // turn end. Walk backwards from nextUserIdx to find it.
    let turnEndMs: number | null = null;
    for (let k = nextUserIdx - 1; k > i; k--) {
      const r = visible[k].role;
      if (r === 'assistant' || r === 'system') {
        turnEndMs = new Date(visible[k].timestamp).getTime();
        break;
      }
    }

    if (turnEndMs == null) {
      // No assistant reply yet for this turn. If the session is
      // actively working, extrapolate to now so the header ticks.
      // Otherwise (terminal session, no reply): contribute 0.
      if (status === 'running' || status === 'waiting_approval') {
        turnEndMs = Date.now();
      } else {
        continue;
      }
    }

    const dur = Math.max(0, turnEndMs - new Date(msg.timestamp).getTime());
    totalMs += dur;
    lastMs = dur;
  }

  return {
    total: Math.max(0, Math.round(totalMs / 1000)),
    last: Math.max(0, Math.round(lastMs / 1000)),
  };
}

function summarizeToolInput(toolName: string, toolInput: Record<string, any>): string {
  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) {
    const keys = Object.keys(toolInput || {});
    if (keys.length === 0) return '';
    if (keys.length === 1) {
      const v = toolInput[keys[0]];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 60) + '…' : s;
    }
    return keys.slice(0, 3).map((k) => {
      const v = toolInput[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${s.length > 30 ? s.slice(0, 30) + '…' : s}`;
    }).join('  ');
  }
  switch (toolName) {
    case 'Bash':
      return toolInput.command || '(command)';
    case 'Read':
      return toolInput.file_path || toolInput.path || '(file)';
    case 'Write':
    case 'Edit':
      return toolInput.file_path || toolInput.path || '(file)';
    case 'Grep':
      return `/${toolInput.pattern || ''}/${toolInput.path ? ` in ${toolInput.path}` : ''}`;
    case 'Glob':
      return toolInput.glob_pattern || toolInput.pattern || '(pattern)';
    case 'AskUserQuestion': {
      const questions = toolInput.questions;
      if (Array.isArray(questions) && questions.length > 0) {
        return questions[0].question || questions[0].prompt || questions[0].text || 'Question pending';
      }
      return 'Question pending';
    }
    default: {
      return toolInput.command || toolInput.file_path || toolInput.path || toolInput.query
        || JSON.stringify(toolInput).slice(0, 60);
    }
  }
}

function getToolDisplayName(toolName: string): string {
  const mcp = parseMcpToolName(toolName);
  if (mcp.isMcp) return mcp.displayName;
  return toolName;
}

// ---------------------------------------------------------------------------
// Resize handle definitions
// ---------------------------------------------------------------------------

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 14;

const CURSOR_MAP: Record<ResizeDir, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
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

// ---------------------------------------------------------------------------
// AgentCard
// ---------------------------------------------------------------------------

interface OuterProps {
  sessionId: string;
  expanded: boolean;
  // Stable getter , cards read pan/zoom on demand (drag math) instead of
  // receiving them as props. Without this, every wheel/pan tick on the
  // canvas re-rendered every card, even though the canvas root's CSS
  // transform is what actually moves them visually. Cards only need the
  // values inside drag callbacks; making it a ref-backed getter keeps
  // pan/zoom out of memo equality entirely.
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  spawnFrom?: { x: number; y: number; type?: 'branch' };
  exitTarget?: { x: number; y: number };
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view') => void;
  onDragMove?: (dx: number, dy: number, mouseX?: number, mouseY?: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBranch?: (sourceSessionId: string, newSessionId: string) => void;
  onMeasuredHeight?: (sessionId: string, height: number) => void;
  snapColumn?: { x: number; width: number };
  autoFocusInput?: boolean;
  onDoubleClick?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  shakeDirection?: 'left' | 'right' | 'up' | 'down' | null;
}

interface Props extends Omit<OuterProps, 'sessionId'> {
  session: AgentSession;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  cardZOrder: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
}

const MIN_W = 480;
const MIN_H = 120;
const EXPANDED_OVERLAY_H = 620;

const SPAWN_SPRING = { type: 'spring' as const, stiffness: 400, damping: 28, mass: 0.6 };
const BRANCH_SPRING = { type: 'spring' as const, stiffness: 300, damping: 26, mass: 0.8 };
const EXIT_SPRING = { type: 'spring' as const, stiffness: 350, damping: 30, mass: 0.7 };
const GLOW_FADE_MS = 2500;

const SNAP_THRESHOLD = 60;

const AgentCard: React.FC<Props> = ({
  session, expanded, cardX, cardY, cardWidth, cardHeight, getCanvasState, spawnFrom, exitTarget,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  onBranch, onMeasuredHeight, snapColumn, autoFocusInput, cardZOrder = 0, onDoubleClick, onBringToFront,
  shakeDirection,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const isDashboardActive = useDashboardActive();
  const hasApiKey = !!useAppSelector((s) => s.settings.data.anthropic_api_key);
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  // Stored value → curated picker label, with a tidy fallback for unknowns.
  const friendlyModelLabel = useMemo(() => {
    const value = session.model;
    if (!value) return '';
    for (const models of Object.values(modelsByProvider)) {
      for (const m of models as any[]) {
        if (m.value === value) return m.label;
      }
    }
    let s = String(value);
    if (s.startsWith('or:')) s = s.slice(3);
    if (s.includes('/')) s = s.split('/').pop() || s;
    return s;
  }, [session.model, modelsByProvider]);
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);

  const cardBoxRef = useRef<HTMLDivElement>(null);
  // Capture isDashboardActive in a ref so the ResizeObserver callback always
  // sees the latest value without forcing the observer to re-attach when the
  // active state flips.
  const isDashboardActiveRef = useRef(isDashboardActive);
  useEffect(() => { isDashboardActiveRef.current = isDashboardActive; }, [isDashboardActive]);
  useEffect(() => {
    const el = cardBoxRef.current;
    if (!el || !onMeasuredHeight) return;
    // Remember the most recent height seen during a suppressed window
    // (pan/drag/zoom in progress). When the interaction ends, fire it
    // through so the layout reconciles to the truth right then.
    let suppressedHeight: number | null = null;
    const ro = new ResizeObserver((entries) => {
      // Short-circuit when dashboard is hidden , observer stays attached so
      // the next resize after returning to the dashboard fires correctly.
      if (!isDashboardActiveRef.current) return;
      // Short-circuit during active canvas interaction (pan/drag/wheel).
      // During those gestures we don't care about millimeter-precise card
      // heights; re-measuring on every streamed character was forcing
      // Dashboard re-renders mid-pan via setMeasuredHeightsTick. Stash
      // the latest height instead and flush on gesture end.
      if (isCanvasInteractionActive()) {
        for (const entry of entries) suppressedHeight = entry.contentRect.height;
        return;
      }
      for (const entry of entries) {
        onMeasuredHeight(session.id, entry.contentRect.height);
      }
    });
    ro.observe(el);
    const unsub = onCanvasInteractionEnd(() => {
      if (suppressedHeight != null && isDashboardActiveRef.current) {
        onMeasuredHeight(session.id, suppressedHeight);
      }
      suppressedHeight = null;
    });
    return () => { ro.disconnect(); unsub(); };
  }, [session.id, onMeasuredHeight]);

  // ---- Glow state (for branched cards) ----
  const glowEntry = useAppSelector((s) => s.dashboardLayout.glowingAgentCards[session.id]);
  const isGlowingRedux = !!glowEntry;
  const glowFading = glowEntry?.fading ?? false;
  const glowFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissGlow = useCallback(() => {
    if (!isGlowingRedux || glowFading) return;
    dispatch(fadeGlowingAgentCard(session.id));
    glowFadeTimer.current = setTimeout(() => {
      dispatch(clearGlowingAgentCard(session.id));
    }, GLOW_FADE_MS + 300);
  }, [isGlowingRedux, glowFading, dispatch, session.id]);

  useEffect(() => () => {
    if (glowFadeTimer.current) clearTimeout(glowFadeTimer.current);
  }, []);

  const accentColor = c.accent.primary;
  const accentHover = c.accent.hover;

  const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
    running: { color: c.status.success, bg: c.status.successBg },
    waiting_approval: { color: c.status.warning, bg: c.status.warningBg },
    completed: { color: c.text.tertiary, bg: c.bg.secondary },
    error: { color: c.status.error, bg: c.status.errorBg },
    stopped: { color: c.text.tertiary, bg: c.bg.secondary },
    draft: { color: c.accent.primary, bg: c.bg.secondary },
  };

  const isDraft = session.status === 'draft';

  // ---- Drag via header (pointer events) ----
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
    onDragStart?.(session.id, 'agent');
  }, [cardX, cardY, onDragStart, session.id, getCanvasState]);

  // Recompute localDragPos from latest pointer + pan (shared by move handler and pan-change event)
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

  // When pan changes during an active drag (edge-pan or wheel-zoom-while-
  // dragging), Dashboard dispatches `openswarm:canvas-pan-changed`. Only
  // active during a drag so non-dragging cards stay subscribed-to-nothing.
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

      if (snapColumn && Math.abs(finalX - snapColumn.x) < SNAP_THRESHOLD) {
        finalX = snapColumn.x;
        dispatch(setCardSize({ sessionId: session.id, width: snapColumn.width, height: cardHeight }));
      }

      // Snap to 24px grid (hold Shift to bypass)
      if (!e.shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }

      dispatch(setCardPosition({ sessionId: session.id, x: finalX, y: finalY }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [dispatch, session.id, onDragEnd, snapColumn, cardHeight, getCanvasState]);

  // ---- Unified edge / corner resize ----
  const resizeRef = useRef<{
    dir: ResizeDir;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [localResize, setLocalResize] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const effectiveW = Math.max(cardWidth, MIN_W);
      const effectiveH = expanded ? Math.max(EXPANDED_OVERLAY_H, cardHeight) : cardHeight;
      resizeRef.current = {
        dir,
        startX: e.clientX,
        startY: e.clientY,
        origX: cardX,
        origY: cardY,
        origW: effectiveW,
        origH: effectiveH,
      };
      setIsResizing(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [cardX, cardY, cardWidth, cardHeight, expanded],
  );

  const computeResize = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return null;
      const { dir, startX, startY, origX, origY, origW, origH } = resizeRef.current;
      const z = getCanvasState().zoom;
      const dx = (e.clientX - startX) / z;
      const dy = (e.clientY - startY) / z;

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
      dispatch(setCardPosition({ sessionId: session.id, x: result.x, y: result.y }));
      dispatch(setCardSize({ sessionId: session.id, width: result.w, height: result.h }));
    }
    resizeRef.current = null;
    setLocalResize(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [computeResize, dispatch, session.id]);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dispatch(collapseSession(session.id));
    dispatch(removeCard(session.id));
    if (glowEntry) {
      setTimeout(() => {
        dispatch(clearGlowingAgentCard(session.id));
      }, 500);
    } else {
      dispatch(closeSession({ sessionId: session.id }));
    }
  };


  // Elapsed-time display owns its own 1Hz tick via <ElapsedTimer/> below;
  // we don't force-re-render the whole 1000+ line AgentCard every second
  // anymore (each card running × 1Hz = wasted reconciliation budget).

  const lastMessage = session.messages[session.messages.length - 1];
  // Subscribe to this card's own streaming entry from the streaming
  // slice. Per-character mutations no longer churn the sessions dict,
  // so other cards stay stable while this one streams.
  const streamingMessage = useStreamingMessage(session.id);
  const isStreaming = !!streamingMessage;
  const previewContent = isStreaming
    ? (streamingMessage!.role === 'tool_call'
        ? `[${getToolDisplayName(streamingMessage!.tool_name || '')}] ${streamingMessage!.content}`
        : streamingMessage!.content
      ).slice(0, 120)
    : lastMessage && typeof lastMessage.content === 'string'
      ? lastMessage.content.slice(0, 120)
      : '';
  const hasPending = session.pending_approvals.length > 0;
  const pendingReq = session.pending_approvals[0];
  const statusStyle = STATUS_COLORS[session.status] || { color: c.text.tertiary, bg: c.bg.secondary };

  const noTransition = isDragging || isResizing || (isSelected && !!multiDragDelta);

  const mdDx = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dx : 0;
  const mdDy = (!isDragging && isSelected && multiDragDelta) ? multiDragDelta.dy : 0;
  const activeX = localResize?.x ?? localDragPos?.x ?? (cardX + mdDx);
  const activeY = localResize?.y ?? localDragPos?.y ?? (cardY + mdDy);
  const activeW = localResize?.w ?? cardWidth;
  const activeH = localResize?.h ?? cardHeight;

  const isBranchSpawn = spawnFrom?.type === 'branch';
  const spawnInitial = spawnFrom
    ? isBranchSpawn
      ? { opacity: 0.5, scale: 0.92, left: spawnFrom.x, top: spawnFrom.y }
      : { opacity: 0, scale: 0.3, left: spawnFrom.x, top: spawnFrom.y }
    : false;
  const spawnTransition = noTransition || !spawnFrom
    ? { duration: 0 }
    : isBranchSpawn
      ? { left: BRANCH_SPRING, top: BRANCH_SPRING, scale: BRANCH_SPRING, opacity: { duration: 0.25 } }
      : { left: SPAWN_SPRING, top: SPAWN_SPRING, scale: SPAWN_SPRING, opacity: { duration: 0.12 } };

  const exitAnimation = exitTarget
    ? {
        opacity: 0,
        scale: 0.3,
        left: exitTarget.x,
        top: exitTarget.y,
        transition: { left: EXIT_SPRING, top: EXIT_SPRING, scale: EXIT_SPRING, opacity: { duration: 0.2 } },
      }
    : { opacity: 0, scale: 0.85, transition: { duration: 0.2 } };

  return (
    <motion.div
      layout={false}
      initial={spawnInitial}
      animate={{ opacity: 1, scale: 1, left: activeX, top: activeY }}
      exit={exitAnimation}
      transition={spawnTransition}
      onPointerDownCapture={() => onBringToFront?.(session.id, 'agent')}
      style={{
        position: 'absolute',
        zIndex: isDragging || isResizing ? 999999 : cardZOrder,
      }}
    >
    <Box
      ref={cardBoxRef}
      data-select-type="agent-card"
      data-select-id={session.id}
      data-select-meta={JSON.stringify({ name: session.name || session.id, status: session.status, model: session.model, mode: session.mode })}
      // Onboarding tiebreaker: when the user has multiple agent cards open
      // (e.g. step 5 leaves the YouTube-summary agent on canvas while
      // step 6 spawns a new orchestrator), per-agent selectors like
      // chat-input need a way to identify the NEWEST card. Object.values
      // iteration order in Dashboard.tsx is keyed by session.id and not
      // monotonic by creation time, so DOM order can't be trusted.
      // ISO date parses cleanly to ms; missing values fall through to the
      // last-DOM-node fallback in resolveSelector.
      data-onboarding-spawn-ms={
        session.created_at
          ? new Date(session.created_at).getTime() || undefined
          : undefined
      }
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        onCardSelect?.(session.id, 'agent', e.shiftKey);
      }}
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onDoubleClick?.(session.id, 'agent');
      }}
      sx={{
        position: 'relative',
        // contain: streaming chat updates inside don't reflow the dashboard.
        // Skipping `paint` here because the highlighted/selected/glow
        // boxShadows legitimately extend past the card border , `paint`
        // containment would clip those visuals.
        contain: 'layout style',
        // Promote each card to its own compositor layer so paint
        // invalidations (hover effects, streaming content updates,
        // highlight pulses) stay contained to that one card's layer
        // instead of forcing the canvas's GPU-promoted root layer to
        // re-paint. The performance trace showed pointer hover events
        // costing 100-200ms of pure presentation time before this,
        // because every hover-cross re-painted the entire canvas
        // composite. Costs ~card_area*4 bytes of GPU memory per card;
        // trivial on modern hardware for the dashboard's card counts.
        willChange: 'transform',
        width: localResize ? activeW : Math.max(cardWidth, MIN_W),
        height: localResize ? activeH : (expanded ? Math.max(EXPANDED_OVERLAY_H, cardHeight) : 'auto'),
        bgcolor: c.bg.surface,
        border: isHighlighted
          ? `2px solid ${c.accent.primary}`
          : (isGlowingRedux && !glowFading)
            ? `2px solid ${accentColor}`
            : isSelected
              ? '2px solid #3b82f6'
              : hasPending && !expanded
                ? `1px solid ${c.status.warning}`
                : expanded
                  ? `1px solid ${c.border.strong}`
                  : `1px solid ${c.border.subtle}`,
        borderRadius: 3,
        p: 2,
        cursor: expanded ? 'default' : 'pointer',
        transition: noTransition
          ? 'none'
          : glowFading
            ? `border ${GLOW_FADE_MS}ms ease-out, box-shadow ${GLOW_FADE_MS}ms ease-out`
            : c.transition,
        boxShadow: isHighlighted
          ? `0 0 0 3px ${c.accent.primary}50, 0 0 20px ${c.accent.primary}35, 0 0 40px ${c.accent.primary}15`
          : (isGlowingRedux && !glowFading)
            ? `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15`
            : isDragging
              ? c.shadow.lg
              : isSelected
                ? `0 0 0 1px #3b82f6, ${c.shadow.md}`
                : expanded
                  ? c.shadow.md
                  : c.shadow.sm,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        ...(shakeDirection && {
          animation: `card-shake-${shakeDirection} 0.3s ease 2`,
          border: `2px solid ${c.status.error}90`,
          boxShadow: `0 0 0 2px ${c.status.error}30, ${c.shadow.md}`,
          '@keyframes card-shake-left': {
            '0%,100%': { transform: 'translateX(0)' },
            '25%': { transform: 'translateX(-6px)' },
            '75%': { transform: 'translateX(4px)' },
          },
          '@keyframes card-shake-right': {
            '0%,100%': { transform: 'translateX(0)' },
            '25%': { transform: 'translateX(6px)' },
            '75%': { transform: 'translateX(-4px)' },
          },
          '@keyframes card-shake-up': {
            '0%,100%': { transform: 'translateY(0)' },
            '25%': { transform: 'translateY(-6px)' },
            '75%': { transform: 'translateY(4px)' },
          },
          '@keyframes card-shake-down': {
            '0%,100%': { transform: 'translateY(0)' },
            '25%': { transform: 'translateY(6px)' },
            '75%': { transform: 'translateY(-4px)' },
          },
        }),
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
              boxShadow: c.shadow.sm,
            },
          },
        }),
        ...(!isHighlighted && isGlowingRedux && !glowFading && {
          animation: 'agent-card-glow-pulse 2s ease-in-out infinite',
          '@keyframes agent-card-glow-pulse': {
            '0%, 100%': {
              boxShadow: `0 0 0 2px ${accentColor}40, 0 0 18px ${accentColor}30, 0 0 40px ${accentColor}15`,
            },
            '50%': {
              boxShadow: `0 0 0 3px ${accentColor}60, 0 0 28px ${accentColor}45, 0 0 56px ${accentColor}25`,
            },
          },
        }),
        ...(!isHighlighted && !(isGlowingRedux && !glowFading) && !expanded && !isDragging && !isSelected && {
          // Hover: borderColor only. Was previously also bumping boxShadow
          // from .sm to .md, but the trace data showed pointer hover events
          // costing 120-207ms PRESENTATION because every shadow change
          // forced a full GPU re-blur of every card on the transformed
          // canvas layer. Border color is layout-free and ~free to paint.
          '&:hover': {
            borderColor: hasPending ? c.status.warning : c.border.strong,
          },
        }),
      }}
    >
      {/* Glow overlays for branched cards */}
      {isGlowingRedux && (
        <Box
          className="agent-card-glow-overlays"
          sx={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            borderRadius: 'inherit',
            zIndex: 20,
            opacity: glowFading ? 0 : 1,
            transition: `opacity ${GLOW_FADE_MS}ms ease-out`,
          }}
        >
          {/* Rotating conic gradient border */}
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              overflow: 'hidden',
              padding: '3px',
              mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
              WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
              maskComposite: 'exclude',
              WebkitMaskComposite: 'xor',
              '&::before': {
                content: '""',
                position: 'absolute',
                inset: '-50%',
                background: `conic-gradient(from 0deg, transparent 0%, ${accentColor} 25%, transparent 50%, ${accentColor} 75%, transparent 100%)`,
                animation: 'agent-card-rotate-glow 3s linear infinite',
              },
              '@keyframes agent-card-rotate-glow': {
                '100%': { transform: 'rotate(360deg)' },
              },
            }}
          />
          {/* Top edge shimmer */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '2px',
              background: `linear-gradient(90deg, transparent, ${accentColor}, ${accentHover}, ${accentColor}, transparent)`,
              backgroundSize: '200% 100%',
              animation: 'agent-card-border-shimmer 2s linear infinite',
              '@keyframes agent-card-border-shimmer': {
                '0%': { backgroundPosition: '200% 0' },
                '100%': { backgroundPosition: '-200% 0' },
              },
            }}
          />
          {/* Inner shadow overlay */}
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              boxShadow: `inset 0 0 40px ${accentColor}30, inset 0 0 80px ${accentColor}12`,
              animation: 'agent-card-inner-pulse 2s ease-in-out infinite',
              '@keyframes agent-card-inner-pulse': {
                '0%, 100%': {
                  boxShadow: `inset 0 0 40px ${accentColor}30, inset 0 0 80px ${accentColor}12`,
                },
                '50%': {
                  boxShadow: `inset 0 0 50px ${accentColor}40, inset 0 0 100px ${accentColor}18`,
                },
              },
            }}
          />
        </Box>
      )}

      {/* Resize handles: 4 edges + 4 corners */}
      {HANDLE_DEFS.map(({ dir, sx }) => (
        <Box
          key={dir}
          onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          onClick={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            ...sx,
            cursor: CURSOR_MAP[dir],
            zIndex: 20,
            userSelect: 'none',
            touchAction: 'none',
          }}
        />
      ))}

      {/* Selection overlay , blocks click interaction while selected, enabling drag from anywhere */}
      {isSelected && (
        <Box
          ref={scrollOverlayRef}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onClick={(e: React.MouseEvent) => {
            if (justDraggedRef.current) return;
            onCardSelect?.(session.id, 'agent', e.shiftKey);
          }}
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 15,
            cursor: isDragging ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        />
      )}

      {/* Drag zone: header + metadata , entire region above separator is draggable */}
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        sx={{
          position: 'relative',
          zIndex: 16,
          mx: -2,
          mt: -2,
          px: 2,
          pt: 2,
          pb: 1.5,
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 1,
            flexShrink: 0,
          }}
        >
          <Box
            className="drag-handle"
            sx={{
              display: 'flex',
              alignItems: 'center',
              mr: 0.5,
              color: c.text.ghost,
            }}
          >
            <DragIndicatorIcon sx={{ fontSize: 16 }} />
          </Box>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              borderRadius: 1,
            }}
          >
            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.name}
            </Typography>
            <Chip
              label={session.status.replace('_', ' ')}
              size="small"
              sx={{
                bgcolor: statusStyle.bg,
                color: statusStyle.color,
                fontWeight: 600,
                fontSize: '0.7rem',
                height: 22,
                flexShrink: 0,
              }}
            />
          </Box>
          <Box
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0, ml: 0.5 }}
          >
            <Tooltip title={isDraft ? 'Remove' : 'Close chat'}>
              <IconButton
                size="small"
                onClick={handleRemove}
                onMouseDown={(e) => e.stopPropagation()}
                sx={{
                  color: c.text.ghost,
                  p: 0.5,
                  '&:hover': { color: c.status.error, bgcolor: `${c.status.errorBg}` },
                }}
              >
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {/* Metadata row */}
        <Box sx={{
          display: isDraft && !expanded ? 'none' : 'flex',
          gap: 1.5,
          flexShrink: 0,
          ...(isDraft && { visibility: 'hidden' }),
        }}>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>
            {friendlyModelLabel}
          </Typography>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>
            {session.mode}
          </Typography>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>
            <ElapsedTimer messages={session.messages} status={session.status} />
          </Typography>
          {session.cost_usd > 0 && hasApiKey && (
            <Typography variant="caption" sx={{ color: c.accent.primary }}>
              ${session.cost_usd.toFixed(4)}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Expanded: inline chat fills remaining space */}
      {expanded && (
        <Box
          onClick={(e) => e.stopPropagation()}
          sx={{
            mx: -2,
            mb: -2,
            flex: 1,
            minHeight: 0,
            borderTop: `1px solid ${c.border.subtle}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <AgentChat
            key={session.id}
            sessionId={session.id}
            onClose={() => dispatch(collapseSession(session.id))}
            embedded
            autoFocus={autoFocusInput}
            isGlowing={isGlowingRedux && !glowFading}
            onDismissGlow={dismissGlow}
            onBranch={onBranch ? (newId: string) => onBranch(session.id, newId) : undefined}
          />
        </Box>
      )}

      {/* Collapsed: preview + approval */}
      {!expanded && (
        <>
          {previewContent && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: hasPending ? 1.5 : 0 }}>
              {isStreaming && (
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    bgcolor: c.accent.primary,
                    flexShrink: 0,
                    animation: 'pulse-dot 1.4s ease-in-out infinite',
                    '@keyframes pulse-dot': {
                      '0%, 100%': { opacity: 0.4, transform: 'scale(0.8)' },
                      '50%': { opacity: 1, transform: 'scale(1.2)' },
                    },
                  }}
                />
              )}
              <Typography
                variant="body2"
                sx={{
                  color: isStreaming ? c.text.secondary : c.text.muted,
                  fontSize: '0.8rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
              >
                {previewContent}
              </Typography>
            </Box>
          )}

          {hasPending && pendingReq && pendingReq.tool_name === 'AskUserQuestion' ? (
            <Box onClick={(e) => e.stopPropagation()}>
              <QuestionForm
                compact
                request={pendingReq}
                onApprove={(requestId, updatedInput) =>
                  dispatch(handleApproval({ requestId, behavior: 'allow', updatedInput }))
                }
                onDeny={(requestId) =>
                  dispatch(handleApproval({ requestId, behavior: 'deny' }))
                }
              />
            </Box>
          ) : hasPending ? (
            <Box onClick={(e) => e.stopPropagation()} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {pendingReq && (
                <Box
                  sx={{
                    bgcolor: c.status.warningBg,
                    border: `1px solid rgba(128,92,31,0.2)`,
                    borderRadius: 2,
                    p: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    {(() => {
                      const mcp = parseMcpToolName(pendingReq.tool_name);
                      if (mcp.isMcp && mcp.service) return <GoogleServiceIcon service={mcp.service} size={18} />;
                      return <TerminalIcon sx={{ fontSize: 16, color: c.status.warning, flexShrink: 0, opacity: 0.8 }} />;
                    })()}
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography sx={{ color: c.status.warning, fontSize: '0.75rem', fontWeight: 600 }}>
                        {getToolDisplayName(pendingReq.tool_name)}
                      </Typography>
                      <Typography
                        sx={{
                          color: c.text.muted,
                          fontSize: '0.7rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {summarizeToolInput(pendingReq.tool_name, pendingReq.tool_input)}
                      </Typography>
                    </Box>
                  </Box>
                  {session.pending_approvals.length === 1 && (
                    <Box sx={{ display: 'flex', gap: 0.5, ml: 1 }}>
                      <Tooltip title="Approve">
                        <IconButton
                          size="small"
                          onClick={() => dispatch(handleApproval({ requestId: pendingReq.id, behavior: 'allow' }))}
                          sx={{ color: c.status.success }}
                        >
                          <CheckCircleIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Deny">
                        <IconButton
                          size="small"
                          onClick={() => dispatch(handleApproval({ requestId: pendingReq.id, behavior: 'deny' }))}
                          sx={{ color: c.status.error }}
                        >
                          <CancelIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  )}
                </Box>
              )}
              {session.pending_approvals.length > 1 && (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    bgcolor: c.status.warningBg,
                    border: `1px solid rgba(128,92,31,0.2)`,
                    borderRadius: 2,
                    px: 1.25,
                    py: 0.75,
                  }}
                >
                  <Typography sx={{ fontSize: '0.75rem', fontWeight: 700, color: c.status.warning, flex: 1 }}>
                    {session.pending_approvals.length} pending approvals
                  </Typography>
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<CheckIcon sx={{ fontSize: '14px !important' }} />}
                    onClick={() => {
                      for (const req of session.pending_approvals) {
                        if (req.tool_name !== 'AskUserQuestion') dispatch(handleApproval({ requestId: req.id, behavior: 'allow' }));
                      }
                    }}
                    sx={{
                      bgcolor: c.status.success,
                      '&:hover': { bgcolor: '#1e4d15' },
                      fontWeight: 600,
                      fontSize: '0.72rem',
                      textTransform: 'none',
                      borderRadius: 1.5,
                      px: 1.25,
                      py: 0.25,
                      minHeight: 26,
                      minWidth: 0,
                    }}
                  >
                    Approve All
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<CloseIcon sx={{ fontSize: '14px !important' }} />}
                    onClick={() => {
                      for (const req of session.pending_approvals) {
                        if (req.tool_name !== 'AskUserQuestion') dispatch(handleApproval({ requestId: req.id, behavior: 'deny' }));
                      }
                    }}
                    sx={{
                      borderColor: c.status.error,
                      color: c.status.error,
                      '&:hover': { borderColor: '#8f2828', bgcolor: 'rgba(181,51,51,0.04)' },
                      fontWeight: 600,
                      fontSize: '0.72rem',
                      textTransform: 'none',
                      borderRadius: 1.5,
                      px: 1.25,
                      py: 0.25,
                      minHeight: 26,
                      minWidth: 0,
                    }}
                  >
                    Deny All
                  </Button>
                </Box>
              )}
            </Box>
          ) : null}
        </>
      )}
    </Box>
    </motion.div>
  );
};

const MemoAgentCard = React.memo(AgentCard);

// Self-subscribing outer: this is what Dashboard renders. Each card reads
// only its own session + card position from Redux, so a streamDelta to
// session A no longer disturbs B's props. Dashboard's iteration just hands
// down sessionId + cross-card UI state (selection, drag, glow).
const AgentCardOuter: React.FC<OuterProps> = (props) => {
  const session = useAppSelector((s) => s.agents.sessions[props.sessionId]);
  const cardEntry = useAppSelector((s) => s.dashboardLayout.cards[props.sessionId]);
  if (!session || !cardEntry) return null;
  return (
    <MemoAgentCard
      {...props}
      session={session}
      cardX={cardEntry.x}
      cardY={cardEntry.y}
      cardWidth={cardEntry.width}
      cardHeight={cardEntry.height}
      cardZOrder={cardEntry.zOrder ?? 0}
    />
  );
};

export default AgentCardOuter;
