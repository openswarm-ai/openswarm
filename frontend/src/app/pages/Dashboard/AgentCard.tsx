import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import ScheduleIcon from '@mui/icons-material/Schedule';
import { motion } from 'framer-motion';
import {
  AgentSession,
  handleApproval,
  toggleExpandSession,
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
import { QuestionForm } from '@/app/pages/AgentChat/ApprovalBar';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import { parseMcpToolName, getMcpShortAction } from '@/app/pages/AgentChat/ToolCallBubble';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useOverlayScrollPassthrough } from './useOverlayScrollPassthrough';

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

function formatDuration(createdAt: string): string {
  const seconds = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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

interface Props {
  session: AgentSession;
  expanded: boolean;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  zoom?: number;
  spawnFrom?: { x: number; y: number; type?: 'branch' };
  exitTarget?: { x: number; y: number };
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragDelta?: { dx: number; dy: number } | null;
  onCardSelect?: (id: string, type: 'agent' | 'view', shiftKey: boolean) => void;
  onDragStart?: (id: string, type: 'agent' | 'view') => void;
  onDragMove?: (dx: number, dy: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
  onBranch?: (sourceSessionId: string, newSessionId: string) => void;
  onMeasuredHeight?: (sessionId: string, height: number) => void;
  snapColumn?: { x: number; width: number };
  autoFocusInput?: boolean;
  cardZOrder?: number;
  onBringToFront?: (id: string, type: 'agent' | 'view' | 'browser') => void;
  onEditSchedule?: (scheduleId: string) => void;
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
  session, expanded, cardX, cardY, cardWidth, cardHeight, zoom = 1, spawnFrom, exitTarget,
  isSelected = false, isHighlighted = false, multiDragDelta, onCardSelect, onDragStart, onDragMove, onDragEnd,
  onBranch, onMeasuredHeight, snapColumn, autoFocusInput, cardZOrder = 0, onBringToFront, onEditSchedule,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected);

  const cardBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardBoxRef.current;
    if (!el || !onMeasuredHeight) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onMeasuredHeight(session.id, entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
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

  const [, setTick] = useState(0);
  const isDraft = session.status === 'draft';

  // ---- Drag via header (pointer events) ----
  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(session.id, 'agent');
  }, [cardX, cardY, onDragStart, session.id]);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const dx = rawDx / zoom;
    const dy = rawDy / zoom;
    setLocalDragPos({
      x: dragState.current.origX + dx,
      y: dragState.current.origY + dy,
    });
    onDragMove?.(dx, dy);
  }, [zoom, onDragMove]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = (e.clientX - dragState.current.startX) / zoom;
    const dy = (e.clientY - dragState.current.startY) / zoom;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      const finalY = dragState.current.origY + dy;

      if (snapColumn && Math.abs(finalX - snapColumn.x) < SNAP_THRESHOLD) {
        finalX = snapColumn.x;
        dispatch(setCardSize({ sessionId: session.id, width: snapColumn.width, height: cardHeight }));
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
  }, [zoom, dispatch, session.id, onDragEnd, snapColumn, cardHeight]);

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


  useEffect(() => {
    if (session.status === 'running' || session.status === 'waiting_approval') {
      const interval = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(interval);
    }
  }, [session.status]);

  const lastMessage = session.messages[session.messages.length - 1];
  const isStreaming = !!session.streamingMessage;
  const previewContent = isStreaming
    ? (session.streamingMessage!.role === 'tool_call'
        ? `[${getToolDisplayName(session.streamingMessage!.tool_name || '')}] ${session.streamingMessage!.content}`
        : session.streamingMessage!.content
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
      
      onClick={(e: React.MouseEvent) => {
        if (justDraggedRef.current) return;
        if (!isSelected && !e.shiftKey) {
          dispatch(toggleExpandSession(session.id));
        }
        onCardSelect?.(session.id, 'agent', e.shiftKey);
      }}
      sx={{
        position: 'relative',
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
          '&:hover': {
            boxShadow: c.shadow.md,
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

      {/* Selection overlay – blocks click interaction while selected, enabling drag from anywhere */}
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

      {/* Drag zone: header + metadata – entire region above separator is draggable */}
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
            {session.schedule_id && (
              <Tooltip title="View Schedule">
                <IconButton
                  size="small"
                  onClick={() => onEditSchedule?.(session.schedule_id!)}
                  onMouseDown={(e) => e.stopPropagation()}
                  sx={{
                    color: c.accent.primary,
                    p: 0.5,
                    '&:hover': { bgcolor: `${c.accent.primary}22` },
                  }}
                >
                  <ScheduleIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
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
            {session.model}
          </Typography>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>
            {session.mode}
          </Typography>
          <Typography variant="caption" sx={{ color: c.text.tertiary }}>
            {formatDuration(session.created_at)}
          </Typography>
          {session.cost_usd > 0 && (
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

export default React.memo(AgentCard);
