import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Fade from '@mui/material/Fade';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckIcon from '@mui/icons-material/Check';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import CloseIcon from '@mui/icons-material/Close';
import TerminalIcon from '@mui/icons-material/Terminal';
import { motion } from 'framer-motion';
import {
  AgentSession,
  handleApproval,
  collapseSession,
  expandSession,
  closeSession,
  fetchSession,
  renameSession,
  sendMessage as sendMessageThunk,
} from '@/shared/state/agentsSlice';
import { displayChatTitle, isLegacyAutoName } from '@/shared/state/sessionDisplay';
import { Typewriter } from '@/app/components/feedback/Animated';
import InlineEditableTitle from '@/app/components/InlineEditableTitle';
import {
  setCardPosition,
  setCardSize,
  fadeGlowingAgentCard,
  clearGlowingAgentCard,
  removeCard,
  recordClosedCard,
} from '@/shared/state/dashboardLayoutSlice';
import { store } from '@/shared/state/store';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import WindowControls, { ARC_CHIP_SX } from './WindowControls';
import { useTiledCard } from './useTiledCard';
import { useCardTiling } from './useCardTiling';
import AgentNarratorPill from '../desktop/AgentNarratorPill';
import { openCardContextMenu, isNativeMenuTarget } from '../desktop/openCardContextMenu';
import { agentCardMenuRows } from './agentCardMenuRows';
import { extractLatestTodos } from '../desktop/agentTodos';
import { extractLiveSteps } from '../desktop/agentLiveSteps';
import { extractLatestShowUi, extractPendingAskUi, freezeIfDone, artifactName, hasWorkAfterLatestShowUi } from '@/app/pages/AgentChat/tool-ui/showUiPayload';
import { useDragEndBackstops } from '../hooks/interaction/useDragEndBackstops';
import { useBrowserPillShot } from '../desktop/useBrowserPillShot';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import AskQuestionCard from '@/app/pages/AgentChat/tool-ui/AskQuestionCard';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import { parseMcpToolName, getMcpShortAction } from '@/shared/mcpToolMeta';
import { useClaudeTokens, DarkTokensScope } from '@/shared/styles/ThemeContext';
import { GLASS_SURFACE, GLASS_SURFACE_BLUR, GLASS_SURFACE_TEXT } from '@/shared/styles/glassSurface';
import { useDashboardActive } from '@/shared/hooks/useDashboardActive';
import { useOverlayScrollPassthrough } from '../hooks/interaction/useOverlayScrollPassthrough';
import { useRenderRing } from '../hooks/interaction/useRenderRing';
import { useStreamingMessage } from '@/shared/state/streamingSlice';
import { isCanvasInteractionActive, onCanvasInteractionEnd } from '@/shared/canvasInteractionState';
import { setCardSidecar } from '@/shared/state/workflowsSlice';
import { openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import { friendlyStatusLabel } from '@/shared/statusLabel';
import { RESIZE_HANDLE_DEFS, RESIZE_CURSOR, type ResizeDir } from './cardResizeHandles';

/** Extract up to 3 substantive user-prompt steps to seed a workflow. */
function isWorkflowSuggestionTool(toolName: unknown, mcpServer?: unknown): boolean {
  const normalizedTool = String(toolName || '').toLowerCase();
  const normalizedServer = String(mcpServer || '').toLowerCase();
  if (!normalizedTool) return false;
  if (normalizedTool === 'suggestconverttoworkflow') return true;
  if (normalizedTool.endsWith('__suggestconverttoworkflow')) return true;
  return normalizedTool.includes('suggestconverttoworkflow') && (
    normalizedTool.includes('openswarm-schedule') ||
    normalizedServer.includes('openswarm-schedule')
  );
}

function isScheduleWorkflowTool(toolName: unknown): boolean {
  const normalizedTool = String(toolName || '').toLowerCase();
  if (!normalizedTool) return false;
  return normalizedTool === 'scheduleworkflow' || normalizedTool.endsWith('__scheduleworkflow');
}

function parseWorkflowSuggestion(text: unknown): { reason: string; cadence: string } | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed?.reason || typeof parsed.reason !== 'string') return null;
    return {
      reason: parsed.reason,
      cadence: typeof parsed.cadence === 'string'
        ? parsed.cadence
        : (typeof parsed.suggested_cadence === 'string' ? parsed.suggested_cadence : ''),
    };
  } catch {
    return null;
  }
}

function parseWorkflowSuggestionFromContent(content: any): { reason: string; cadence: string } | null {
  return parseWorkflowSuggestion(
    content?.text ??
    content?.content?.[0]?.text ??
    content?.result ??
    content?.output,
  );
}

/** Detect if the session has a completed SuggestConvertToWorkflow tool call. */
function findWorkflowSuggestion(session: AgentSession): { reason: string; cadence: string } | null {
  let found: { reason: string; cadence: string } | null = null;
  for (const msg of session.messages || []) {
    const msgAny = msg as any;
    const directContent = msgAny.content;
    if (msgAny.role === 'tool_result') {
      const toolName = directContent?.tool_name ?? directContent?.tool ?? directContent?.name ?? msgAny.tool_name;
      if (isWorkflowSuggestionTool(toolName, directContent?.mcpServer ?? msgAny.mcpServer)) {
        found = parseWorkflowSuggestionFromContent(directContent) || found;
      }
    }

    const blocks = Array.isArray(directContent) ? directContent : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      const toolName = block?.tool_name ?? block?.tool ?? block?.name;
      if (isWorkflowSuggestionTool(toolName, block?.mcpServer)) {
        found = parseWorkflowSuggestionFromContent(block) || found;
      }
    }
  }
  return found;
}

/** Count completed ScheduleWorkflow tool calls so a new one (vs the mount baseline) can pop the workflow open. */
function countScheduleWorkflowCalls(session: AgentSession): number {
  let count = 0;
  for (const msg of session.messages || []) {
    const msgAny = msg as any;
    const directContent = msgAny.content;
    if (msgAny.role === 'tool_result') {
      const toolName = directContent?.tool_name ?? directContent?.tool ?? directContent?.name ?? msgAny.tool_name;
      if (isScheduleWorkflowTool(toolName)) count += 1;
    }
    const blocks = Array.isArray(directContent) ? directContent : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      if (isScheduleWorkflowTool(block?.tool_name ?? block?.tool ?? block?.name)) count += 1;
    }
  }
  return count;
}

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





interface OuterProps {
  sessionId: string;
  expanded: boolean;
  // Stable getter, cards read pan/zoom on demand (drag math) instead of receiving them as props. Without this, every wheel/pan tick on the canvas re-rendered every card, even though the canvas root's CSS transform is what actually moves them visually. Cards only need the values inside drag callbacks; making it a ref-backed getter keeps pan/zoom out of memo equality entirely.
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  spawnFrom?: { x: number; y: number; type?: 'branch' };
  exitTarget?: { x: number; y: number };
  isSelected?: boolean;
  isHighlighted?: boolean;
  multiDragActive?: boolean;
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
  session, expanded: expandedInStore, cardX, cardY, cardWidth, cardHeight, getCanvasState, spawnFrom, exitTarget,
  isSelected = false, isHighlighted = false, multiDragActive = false, onCardSelect, onDragStart, onDragMove, onDragEnd,
  onBranch, onMeasuredHeight, snapColumn, autoFocusInput, cardZOrder = 0, onDoubleClick, onBringToFront,
  shakeDirection,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const commitPosition = useCallback((x: number, y: number) => {
    dispatch(setCardPosition({ sessionId: session.id, x, y }));
  }, [dispatch, session.id]);
  const tiling = useCardTiling({ cardId: session.id, getCanvasState, commitPosition });
  const tileZone = tiling.zone;
  const isTiled = !!tileZone;
  const isFullscreen = tileZone === 'fullscreen';
  // A tiled chat IS an open chat. One flag drives the window's SIZE and its SKIN together, so a tile
  // can never wear the collapsed card's light surface (that was "fullscreen turns white").
  const expanded = expandedInStore || isTiled;
  const isDashboardActive = useDashboardActive();
  const hasApiKey = !!useAppSelector((s) => s.settings.data.anthropic_api_key);
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);
  const workflowSuggestion = useMemo(() => findWorkflowSuggestion(session), [session]);
  // Suppress the convert-suggestion glow when this chat is already entangled with a workflow. Two cases: (a) The session is one of a workflow's runner sessions, OR (b) The session is the source the workflow was originally derived from. Either way a fresh convert would just clone the workflow, which is confusing identity collapse.
  const workflowRunsMap = useAppSelector((s) => s.workflows.runs);
  const workflowItems = useAppSelector((s) => s.workflows.items);
  const linkedWorkflowSidecarId = useAppSelector((s) => {
    const entry = Object.values(s.workflows.openCards).find((card) => card.sidecarSessionId === session.id);
    return entry?.workflowId ?? null;
  });
  const sourceWorkflow = useMemo(() => {
    for (const wf of Object.values(workflowItems || {})) {
      if (wf.source_session_id === session.id) return wf;
    }
    return null;
  }, [workflowItems, session.id]);
  const isWorkflowRunnerSession = useMemo(() => {
    // A Test Agent (spawned to validate a workflow draft) isn't a chat to convert; it carries workflow_test_state.
    if (session.workflow_test_state) return true;
    for (const arr of Object.values(workflowRunsMap || {})) {
      for (const r of arr || []) {
        if (r.session_id === session.id) return true;
      }
    }
    return Boolean(sourceWorkflow);
  }, [workflowRunsMap, sourceWorkflow, session.id, session.workflow_test_state]);
  const hasUserPrompt = useMemo(
    () => session.messages.length > 0
      ? session.messages.some((m) => m.role === 'user' && !m.hidden)
      : !!session.first_user_message,
    [session.messages, session.first_user_message],
  );
  const messageCount = session.messages.length > 0
    ? session.messages.length
    : session.message_count ?? 0;
  const isConvertBlockedByTurn = session.status !== 'completed' && session.status !== 'stopped';
  const showConvertToWorkflow =
    !session.is_welcome_draft &&
    !isWorkflowRunnerSession &&
    hasUserPrompt &&
    (messageCount >= 2 || isConvertBlockedByTurn || !!workflowSuggestion);
  const canConvertToWorkflow = showConvertToWorkflow && !isConvertBlockedByTurn;
  const scrollOverlayRef = useOverlayScrollPassthrough(isSelected && !expanded);

  const suggestionPulseRef = useRef('');
  const readyPulseRef = useRef('');
  useEffect(() => {
    if (!workflowSuggestion) return;
    const key = `${workflowSuggestion.reason}|${workflowSuggestion.cadence}`;
    if (canConvertToWorkflow) {
      if (readyPulseRef.current === key) return;
      readyPulseRef.current = key;
    } else {
      if (suggestionPulseRef.current === key) return;
      suggestionPulseRef.current = key;
    }
    dispatch(fadeGlowingAgentCard(session.id));
  }, [workflowSuggestion, canConvertToWorkflow, dispatch, session.id]);

  // When the agent schedules a workflow from this chat, open it in the Workflows app. Baseline the count once on mount so historical schedules (e.g. after an app reload) don't re-open on their own.
  const scheduleWorkflowCount = useMemo(() => countScheduleWorkflowCalls(session), [session]);
  const baselineScheduleCountRef = useRef<number | null>(null);
  const autoOpenedWorkflowIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (baselineScheduleCountRef.current === null) {
      baselineScheduleCountRef.current = scheduleWorkflowCount;
      return;
    }
    if (scheduleWorkflowCount <= baselineScheduleCountRef.current) return;
    for (const wf of Object.values(workflowItems || {})) {
      if (wf.source_session_id !== session.id) continue;
      if (autoOpenedWorkflowIdsRef.current.has(wf.id)) continue;
      autoOpenedWorkflowIdsRef.current.add(wf.id);
      dispatch(openWorkflowsApp({ workflowId: wf.id }));
    }
  }, [scheduleWorkflowCount, workflowItems, session.id, dispatch]);

  const cardBoxRef = useRef<HTMLDivElement>(null);
  // Ref so ResizeObserver sees latest value without re-attaching when active flips.
  const isDashboardActiveRef = useRef(isDashboardActive);
  useEffect(() => { isDashboardActiveRef.current = isDashboardActive; }, [isDashboardActive]);
  useEffect(() => {
    const el = cardBoxRef.current;
    if (!el || !onMeasuredHeight) return;
    // Stash height during pan/drag/zoom; flush on gesture end so layout reconciles.
    let suppressedHeight: number | null = null;
    const ro = new ResizeObserver((entries) => {
      // Short-circuit when dashboard is hidden, observer stays attached so the next resize after returning to the dashboard fires correctly.
      if (!isDashboardActiveRef.current) return;
      // Re-measuring per streamed character mid-pan was forcing Dashboard re-renders via setMeasuredHeightsTick.
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

  const isDraft = session.status === 'draft';

  const DRAG_THRESHOLD = 3;
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number; startPanX: number; startPanY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // A press on an interactive control (an AskUI option/Confirm/Send, a composer field, any
    // button/input) must reach that control. Without this the pill-host's pointer capture ate the
    // click, so a live question in the collapsed pill looked dead until you expanded the card (ENG-232).
    let ctrl = e.target as HTMLElement | null;
    while (ctrl && ctrl !== e.currentTarget) {
      const tag = ctrl.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ctrl.isContentEditable || ctrl.getAttribute('role') === 'button') return;
      ctrl = ctrl.parentElement;
    }
    // A fullscreen window has no drag (macOS rule); arming the machinery here let a title wiggle
    // untile the card mid-click and a plain click wipe tiledGeometry's camera transform, which is
    // the "fullscreen shifted left with the traffic lights cut off" bug.
    if (tiling.zone === 'fullscreen') return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getCanvasState();
    const popped = tiling.untileForDrag(e.clientX, e.clientY, cardWidth);
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      origX: popped?.x ?? cardX, origY: popped?.y ?? cardY,
      startPanX: cs.panX, startPanY: cs.panY,
    };
    if (popped) setLocalDragPos(popped);
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    didDrag.current = false;
    setIsDragging(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    onDragStart?.(session.id, 'agent');
  }, [cardX, cardY, cardWidth, onDragStart, session.id, getCanvasState, tiling]);

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
    // Imperative compositor move, ZERO React work per frame: a setState here re-rendered the whole card (an expanded chat re-runs its full transcript) on every pointermove and every edge-pan tick, which is the drag lag. The motion.div stays parked at its start position; this transform carries the delta; React commits once, at drag end.
    const el = cardBoxRef.current as HTMLElement | null;
    if (el) el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    onDragMove?.(dx, dy, clientX, clientY);
  }, [onDragMove, getCanvasState]);

  // Dashboard dispatches openswarm:canvas-pan-changed during edge-pan/wheel-zoom; only subscribed while dragging.
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

  const finalizeDrag = useCallback((clientX: number, clientY: number, shiftKey: boolean) => {
    if (!dragState.current) return;
    const cs = getCanvasState();
    const z = cs.zoom;
    const panDx = (cs.panX - dragState.current.startPanX) / z;
    const panDy = (cs.panY - dragState.current.startPanY) / z;
    const dx = (clientX - dragState.current.startX) / z - panDx;
    const dy = (clientY - dragState.current.startY) / z - panDy;
    if (didDrag.current) {
      let finalX = dragState.current.origX + dx;
      let finalY = dragState.current.origY + dy;

      if (snapColumn && Math.abs(finalX - snapColumn.x) < SNAP_THRESHOLD) {
        finalX = snapColumn.x;
        dispatch(setCardSize({ sessionId: session.id, width: snapColumn.width, height: cardHeight }));
      }

      // Snap to 24px grid (Shift bypasses).
      if (!shiftKey) {
        finalX = Math.round(finalX / 24) * 24;
        finalY = Math.round(finalY / 24) * 24;
      }

      dispatch(setCardPosition({ sessionId: session.id, x: finalX, y: finalY }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
      // Drop the imperative drag transform in the SAME frame the committed position lands, or the card paints double-offset for a beat. Only when this drag actually wrote it: on a tiled card the transform belongs to tiledGeometry, and clearing it on a plain click shifted the tile by the camera offset.
      const el = cardBoxRef.current as HTMLElement | null;
      if (el) el.style.transform = '';
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
  }, [dispatch, session.id, onDragEnd, snapColumn, cardHeight, getCanvasState]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    finalizeDrag(e.clientX, e.clientY, e.shiftKey);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* capture already gone */ }
  }, [finalizeDrag]);

  const abortDrag = useCallback(() => {
    if (!dragState.current) return;
    finalizeDrag(lastPointerRef.current.clientX, lastPointerRef.current.clientY, true);
  }, [finalizeDrag]);
  useDragEndBackstops(isDragging, finalizeDrag, abortDrag);

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
      let effectiveX = cardX;
      let effectiveY = cardY;
      let effectiveW = Math.max(cardWidth, MIN_W);
      let effectiveH = expanded ? Math.max(EXPANDED_OVERLAY_H, cardHeight) : cardHeight;
      const popped = tiling.untileForResize();
      if (popped) {
        effectiveX = popped.x; effectiveY = popped.y; effectiveW = popped.w; effectiveH = popped.h;
        setLocalResize({ x: effectiveX, y: effectiveY, w: effectiveW, h: effectiveH });
      }
      resizeRef.current = {
        dir,
        startX: e.clientX,
        startY: e.clientY,
        origX: effectiveX,
        origY: effectiveY,
        origW: effectiveW,
        origH: effectiveH,
      };
      setIsResizing(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [cardX, cardY, cardWidth, cardHeight, expanded, tiling],
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

      // An enlarged card can't be shrunk below its content-showing height, else the user resizes the
      // chat down until the transcript vanishes (which felt broken). Collapsed cards keep the tiny floor.
      const minH = expanded ? EXPANDED_OVERLAY_H : MIN_H;
      if (newW < MIN_W) { if (dir.includes('w')) newX = origX + origW - MIN_W; newW = MIN_W; }
      if (newH < minH) { if (dir.includes('n')) newY = origY + origH - minH; newH = minH; }

      return { x: newX, y: newY, w: newW, h: newH };
    },
    [getCanvasState, expanded],
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

  const handleRemove = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    if (linkedWorkflowSidecarId) {
      dispatch(setCardSidecar({ workflowId: linkedWorkflowSidecarId, sessionId: null, kind: null }));
    }
    // Closing the chat takes its browsers with it (Haik's ENG-249: the old undock-and-pin behavior
    // read as the browser "popping open on its own", forcing a second cleanup every time). Each one
    // lands in recently-closed first, so Cmd+Shift+T brings it back if it was wanted.
    if (!glowEntry) {
      for (const bc of Object.values(store.getState().dashboardLayout.browserCards)) {
        if (bc.docked_to !== session.id && bc.spawned_by !== session.id) continue;
        dispatch(recordClosedCard({ kind: 'browser', id: bc.browser_id }));
        removeBrowserCardCleanly(bc.browser_id, dispatch);
      }
    }
    // Record for Cmd+Shift+T BEFORE removeCard wipes the position, but only on a real close (the glow branch just clears a tether, it doesn't close the session).
    if (!glowEntry) dispatch(recordClosedCard({ kind: 'agent', id: session.id }));
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

  const onMinimize = (): void => { dispatch(collapseSession(session.id)); };
  const onTile = (zone: string): void => {
    // A collapsed chat has nothing to fill a zone with, so tiling one opens it first.
    if (zone !== 'restore') dispatch(expandSession(session.id));
    tiling.applyZone(zone);
  };

  const lastMessage = session.messages[session.messages.length - 1];
  // Subscribe to this card's own streaming entry so per-character mutations don't churn other cards.
  const streamingMessage = useStreamingMessage(session.id);
  const isStreaming = !!streamingMessage;
  const previewContent = isStreaming
    ? (streamingMessage!.role === 'tool_call'
        ? `[${getToolDisplayName(streamingMessage!.tool_name || '')}] ${streamingMessage!.content}`
        : streamingMessage!.content
      ).slice(0, 120)
    : lastMessage && typeof lastMessage.content === 'string'
      ? lastMessage.content.slice(0, 120)
      : session.last_message_preview ?? '';
  const hasPending = session.pending_approvals.length > 0;
  const pendingReq = session.pending_approvals[0];

  // Desktop-shell narrator pill: a collapsed card with nothing to ask renders as the minimal pill
  // (live turn label + plan checklist); approvals and drafts keep the full card so their UI has a home.
  const todos = useMemo(() => extractLatestTodos(session.messages || []), [session.messages]);
  const liveSteps = useMemo(
    () => (session.status === 'running' ? extractLiveSteps(session.messages || []) : null),
    [session.messages, session.status],
  );
  const pillArtifact = useMemo(() => {
    const msgs = session.messages || [];
    const artifact = extractLatestShowUi(msgs);
    if (!artifact) return null;
    // A plan/progress widget posted mid-turn goes stale the moment work continues, so while running
    // the pill prefers living surfaces (browser shot, live steps, todos). But "stale" means NOTHING
    // HAPPENED SINCE, not "it is named plan": a skill whose whole job is a live-updating tracker
    // re-emits it as the newest thing in the transcript, and hiding that left the collapsed view
    // showing older state all day (ENG-272). So only suppress it when real work followed it.
    if (session.status === 'running' && /plan|progress/i.test(artifactName(artifact))
        && hasWorkAfterLatestShowUi(msgs)) {
      return null;
    }
    return freezeIfDone(artifact, session.status === 'running');
  }, [session.messages, session.status]);
  const pillAskPair = useMemo(
    () => (session.status === 'running' ? extractPendingAskUi(session.messages || []) : null),
    [session.messages, session.status],
  );
  // Drafts collapse to the pill like everything else; only a pending approval keeps the full card, since you have to see what you are approving.
  const pillMode = !expanded && !hasPending && !tileZone;
  // Pre-render a ring of canvas around the camera so a pan lands on already-drawn pills (ENG-301).
  const ringNear = useRenderRing(cardX, cardY, cardWidth, cardHeight, getCanvasState, pillMode && !isFullscreen);

  // Two-phase expand: mounting a long transcript synchronously inside the expand click blocked its paint for ~630ms (the measured INP worst case), so the click paints the expanded shell first and the chat mounts on the next frame.
  // Keep-alive: once mounted, the chat STAYS mounted across collapse (hidden, not unmounted). The transcript windowing bounds its kept DOM to ~a screen of bubbles, and re-expand becomes a display toggle instead of a full subtree rebuild + WS reconnect.
  const [chatMounted, setChatMounted] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const raf = requestAnimationFrame(() => setChatMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [expanded]);
  // Glass bubble + fullscreen scrim are both dark in either theme, so the title goes light on them.
  const titleColor = expanded ? GLASS_SURFACE_TEXT : c.text.primary;
  // The answer a finished turn actually spoke, for pills with no widget/plan to show. Only the last assistant say, never a tool line.
  const pillFinalText = useMemo(() => {
    if (session.status === 'running') return null;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === 'user') break;
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        return m.content.trim().slice(0, 400);
      }
    }
    return session.last_message_preview?.trim() || null;
  }, [session.messages, session.status, session.last_message_preview]);
  const pillLabel = session.turn_label?.label || displayChatTitle(session);
  const pillRunning = session.status === 'running';
  // The boot restore marks a cut-off turn 'stopped' ONLY when the agent still owes a response
  // (SessionPersistence finalize); surfacing it here is what makes an interrupted chat visible
  // from the board instead of behind a Resume button inside the card (ENG-321).
  // Interrupted = stopped while still OWING a reply (last real message is the user's). Bare
  // status==='stopped' lit the chip on every deliberately-stopped or ancient session at once
  // (Eric's board, 2026-08-17); a chat whose last word was the assistant's owes nothing.
  const pillInterrupted = React.useMemo(() => {
    if (session.status !== 'stopped' || session.workflow_run_id) return false;
    const branch = session.active_branch_id || 'main';
    const msgs = (session.messages || []).filter((m) => (m.branch_id || 'main') === branch && !m.hidden);
    const last = msgs[msgs.length - 1];
    return !!last && last.role === 'user';
  }, [session.status, session.workflow_run_id, session.messages, session.active_branch_id]);
  const handleResumeInterrupted = React.useCallback(() => {
    dispatch(sendMessageThunk({
      sessionId: session.id,
      prompt: "Continue your previous response from exactly where it was cut off. Do not repeat anything you already wrote; pick up mid-sentence if you need to and keep going.",
      mode: session.mode,
      model: session.model,
      hidden: true,
    }));
  }, [dispatch, session.id, session.mode, session.model]);

  // Cold-loaded collapsed cards carry no transcript (status frames are slim), so the pill can't pin
  // its widget/checklist artifact; hydrate ONCE per card actually on this dashboard, never in a loop.
  const pillHydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (!pillMode || pillHydratedRef.current) return;
    pillHydratedRef.current = true;
    if ((session.messages || []).length === 0) dispatch(fetchSession(session.id));
  }, [pillMode, session.messages, session.id, dispatch]);

  // f7's collapsed state: a session's browser (spawned by it or docked into it) shows under the pill.
  const browserShot = useBrowserPillShot(session.id, pillMode && !pillArtifact);

  // justDraggedRef: the motion.div parks at the START position for the whole imperative drag, so the end-of-drag commit must snap (not spring) to the final spot or the card visibly re-glides from where the drag began.
  const noTransition = isDragging || isResizing || (isSelected && multiDragActive) || justDraggedRef.current;

  const activeX = localResize?.x ?? localDragPos?.x ?? cardX;
  const activeY = localResize?.y ?? localDragPos?.y ?? cardY;
  const activeW = localResize?.w ?? cardWidth;
  const activeH = localResize?.h ?? cardHeight;
  const tiledSize = useTiledCard({ cardId: session.id, zone: tileZone, active: true, originX: activeX, originY: activeY, getCamera: getCanvasState });

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
      // While tiled the card is pinned to the viewport: position must track pan instantly, never spring.
      transition={isTiled ? { ...spawnTransition, left: { duration: 0 }, top: { duration: 0 } } : spawnTransition}
      onPointerDownCapture={() => onBringToFront?.(session.id, 'agent')}
      style={{
        position: 'absolute',
        zIndex: isTiled ? 999990 : isDragging || isResizing ? 999999 : cardZOrder,
      }}
    >
    <Box
      ref={cardBoxRef}
      className="osw-card"
      data-select-type="agent-card"
      data-select-id={session.id}
      data-select-meta={JSON.stringify({ name: session.name || session.id, status: session.status, model: session.model, mode: session.mode })}
      // Onboarding tiebreaker: ISO-date sorts the newest card for per-agent selectors; DOM order isn't creation order.
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
      onContextMenu={(e: React.MouseEvent) => { if (isNativeMenuTarget(e)) return; if ((e.target as HTMLElement).closest?.('[data-chat-transcript]')) return; openCardContextMenu(e, {
        rename: { value: displayChatTitle(session), onCommit: (name) => dispatch(renameSession({ sessionId: session.id, name })) },
        items: agentCardMenuRows({
          session, dispatch, expanded, tileZone, expandedSessionIds,
          card: { x: cardX, y: cardY, width: cardWidth, height: cardHeight },
          onTile, onClose: () => handleRemove(),
        }),
      }); }}
      sx={{
        position: 'relative',
        // Hover runway for the pop-above header: the header is pointer-events:none until the CARD
        // is hovered, but it floats ABOVE the card's box, so without this strip the pointer leaving
        // the card to reach it dropped :hover and the header died mid-approach (chats ungrabbable).
        ...(expanded && !isTiled && !pillMode && {
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            right: 0,
            top: -48,
            height: 48,
          },
        }),
        // contain: streaming chat updates inside don't reflow the dashboard. Skipping `paint` here because the highlighted/selected/glow boxShadows legitimately extend past the card border, `paint` containment would clip those visuals.
        contain: 'layout style',
        // Every past session on a dashboard IS a card, so a long-lived board mounts hundreds of
        // pills and pays to render all of them every pan frame. content-visibility lets the browser
        // skip the ones off screen. Measured at 150 heavy sessions / 161 cards under 4x CPU
        // throttling: p95 frame gap 80.4ms -> 21.4ms, dropped frames 96 -> 1 (ENG-261).
        // COLLAPSED cards only, and never a webview host: a skipped guest stops painting, and the
        // expanded card is the one you are reading. contain-intrinsic-size keeps a skipped card's
        // box the size it would have been, so tethers and fit-to-view still measure it correctly.
        ...(pillMode && !expanded && !isFullscreen && !tiledSize ? {
          // Inside the camera ring: force-render so arriving pans hit pre-drawn pixels (ENG-301,
          // Eric's render-ahead call); outside it: keep the ENG-261 skip that holds big boards.
          contentVisibility: ringNear ? 'visible' : 'auto',
          // `auto` = remember the size this card last really rendered at, falling back to the guess
          // only before its first paint. A pill is fit-content/auto sized, so a fixed guess is wrong
          // for every card and costs a relayout each time one scrolls in: measured 27.8ms p95 with a
          // fixed guess vs 21.4ms remembering the real size, at 4x throttle.
          containIntrinsicSize: `auto ${Math.max(1, Math.round(cardWidth))}px auto 120px`,
        } : {}),
        // Each card gets its own compositor layer; hover-cross used to cost 100-200ms PRESENTATION by re-painting the whole canvas.
        willChange: 'transform',
        width: pillMode ? 'fit-content' : tiledSize ? tiledSize.width : (localResize ? activeW : Math.max(cardWidth, MIN_W)),
        height: tiledSize ? tiledSize.height : (localResize ? activeH : (expanded ? Math.max(EXPANDED_OVERLAY_H, cardHeight) : 'auto')),
        transformOrigin: tiledSize ? '0 0' : undefined,
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
        borderRadius: isFullscreen ? '12px' : 3,
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
            ? `0 0 0 2px ${accentColor}40, 0 0 16px ${accentColor}22`
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
        ...(!isHighlighted && !(isGlowingRedux && !glowFading) && !expanded && !isDragging && !isSelected && {
          // Hover changes borderColor only; boxShadow changes used to cost 120-207ms PRESENTATION via GPU re-blur.
          '&:hover': {
            borderColor: hasPending ? c.status.warning : c.border.strong,
          },
        }),
        // Narrator pill sheds every bit of card chrome; the pill body draws its own glass + ring.
        ...(pillMode && {
          bgcolor: 'transparent',
          border: 'none',
          boxShadow: 'none',
          p: 0,
          overflow: 'visible',
          cursor: isDragging ? 'grabbing' : 'grab',
          '&:hover': {},
        }),
        // Expanded chat wears the desktop dark glass; the header only surfaces on hover. Tiled keeps
        // the SAME dark surface (excluding it rendered the light-theme white card, the "fullscreen
        // turns white" bug) but solid + blur-free: nothing shows behind a tiled card, and a
        // window-sized backdrop blur is pure GPU tax.
        ...(expanded && {
          // Warm near-neutral dark (the Claude/ChatGPT family) instead of the saturated plum: long
          // reading sessions want a quiet ground; the accent system carries the brand color.
          bgcolor: isTiled ? 'rgb(33,31,36)' : 'rgba(33,31,36,0.88)',
          ...(isTiled ? {} : {
            backdropFilter: 'blur(24px) saturate(150%)',
            WebkitBackdropFilter: 'blur(24px) saturate(150%)',
          }),
          border: isFullscreen ? 'none' : isSelected ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,0.08)',
          borderRadius: isTiled ? '12px' : '20px',
          boxShadow: '0 18px 48px rgba(0,0,0,0.4)',
          // The hover header floats ABOVE the card; the root must not clip it (the chat body clips itself).
          ...(isTiled ? {} : { overflow: 'visible' }),
        }),
      }}
    >
      {!pillMode && RESIZE_HANDLE_DEFS.map(({ dir, css }) => (
        <Box
          key={dir}
          onPointerDown={handleResizeDown(dir)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          onClick={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            ...css,
            cursor: RESIZE_CURSOR[dir],
            zIndex: 20,
            userSelect: 'none',
            touchAction: 'none',
          }}
        />
      ))}

      {/* Selection overlay , drag-from-anywhere for a COLLAPSED selected card. Never over an expanded chat: it would sit on the composer/transcript so you couldn't type or click (that was "chat opens stuck in drag mode"). Expanded chats drag via the header zone below (zIndex 16). */}
      {isSelected && !expanded && (
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

      {/* Grab band: the top sliver of an expanded card drags it, matching the "grab the window by
          its top edge" instinct; the pop-above header remains the labeled handle. */}
      {expanded && !isTiled && !pillMode && (
        <Box
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onPointerCancel={abortDrag}
          onLostPointerCapture={abortDrag}
          sx={{ position: 'absolute', top: 0, left: 8, right: 8, height: 26, zIndex: 18, cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        />
      )}
      {pillMode && (
        <Box
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          className="osw-pill-host"
          // The 50px reserved above the capsule is for the hover chip to live in, NOT a grab zone:
          // without pointerEvents none the empty band would answer clicks and drag the pill from
          // half a card away. Children opt back in, and their events still bubble to the drag
          // handlers here, so grabbing the capsule itself works exactly as before.
          sx={{
            position: 'relative', touchAction: 'none', userSelect: 'none',
            pt: '50px', mt: '-50px', pointerEvents: 'none',
            '& > *': { pointerEvents: 'auto' },
            '&:hover .osw-pill-lights': { opacity: 1, pointerEvents: 'auto' },
          }}
        >
          {/* Fully above the capsule: at top -8 the 40px round chip hid behind the ~34px pill and hover revealed only its crown, which read as a deformed corner plus a stray shadow (Eric, 2026-08-14). No osw-card class: wearing it dressed this chip in card selection/shadow chrome. */}
          <Box
            className="osw-pill-lights"
            onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
            sx={{
              ...ARC_CHIP_SX,
              position: 'absolute', top: -44, left: 4, zIndex: 2, background: 'rgba(24,14,32,0.85)',
              backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              opacity: 0, pointerEvents: 'none', transition: 'opacity 140ms ease',
            }}
          >
            <WindowControls
              onClose={() => handleRemove()}
              onMinimize={() => dispatch(expandSession(session.id))}
              onTile={onTile}
              tiled={false}
            />
          </Box>
          <AgentNarratorPill
            label={pillLabel}
            running={pillRunning}
            interrupted={pillInterrupted}
            onResumeInterrupted={handleResumeInterrupted}
            todos={todos}
            liveSteps={liveSteps}
            artifact={pillArtifact}
            askPair={pillAskPair}
            sessionId={session.id}
            browserShot={browserShot}
            finalText={pillFinalText}
            selected={isSelected}
            highlighted={isHighlighted}
          />
        </Box>
      )}

      {/* Drag zone: header + metadata , entire region above separator is draggable.
          Expanded desktop cards float it as a hover-reveal overlay so the chat reads chromeless. */}
      {!pillMode && (
      <Box
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={abortDrag}
        onLostPointerCapture={abortDrag}
        sx={{
          ...(expanded
            ? isTiled
              ? {
                  // Fullscreen/tiled: no room above the card, so the scrim rides on top. Never hidden: in fullscreen the title and the lights are the only way out.
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  zIndex: 17,
                  px: 2,
                  pt: 1.5,
                  pb: 2,
                  opacity: 1,
                  background: 'linear-gradient(to bottom, rgba(20,12,28,0.92) 0%, rgba(20,12,28,0.65) 60%, rgba(20,12,28,0) 100%)',
                  borderRadius: '12px 12px 0 0',
                  // Header text must read over the dark scrim regardless of app theme.
                  '& .MuiTypography-root': { color: 'rgba(255,255,255,0.92)' },
                  '& input': { color: 'rgba(255,255,255,0.92)' },
                }
              : {
                  // On the canvas the title + lights pop up ABOVE the card, same as the minimized pill. Always visible: a hover-only name means you can't tell your agents apart at a glance.
                  position: 'absolute',
                  bottom: '100%',
                  top: 'auto',
                  left: 0,
                  right: 0,
                  zIndex: 17,
                  px: 0.25,
                  pb: 0.75,
                }
            : {
                position: 'relative',
                zIndex: 16,
                mx: -2,
                mt: -2,
                px: 2,
                pt: 2,
                pb: 1.5,
              }),
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
            onPointerDown={(e) => e.stopPropagation()}
            sx={{ display: 'flex', alignItems: 'center', mr: 0.75, flexShrink: 0 }}
          >
            <WindowControls onClose={() => handleRemove()} onMinimize={onMinimize} onTile={onTile} tiled={!!tileZone} />
          </Box>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              // Expanded titles wear the same glass bubble as the collapsed pill; a bare label floating over the canvas read as a stray caption.
              ...(expanded && !isTiled && {
                alignSelf: 'flex-start',
                flex: '0 1 auto',
                // mr auto or the row's space-between flings the bubble to the far edge, away from the lights.
                mr: 'auto',
                maxWidth: '100%',
                px: 1.25,
                py: 0.375,
                borderRadius: 999,
                background: GLASS_SURFACE,
                backdropFilter: GLASS_SURFACE_BLUR,
                WebkitBackdropFilter: GLASS_SURFACE_BLUR,
                boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
              }),
              ...(!(expanded && !isTiled) && { borderRadius: 1 }),
            }}
          >
            <InlineEditableTitle
              value={displayChatTitle(session)}
              onCommit={(name) => dispatch(renameSession({ sessionId: session.id, name }))}
              sx={{ flex: '0 1 auto', minWidth: 0, maxWidth: '100%', color: titleColor, fontWeight: 600, fontSize: '1rem' }}
            >
              <Typewriter
                value={displayChatTitle(session)}
                enabled={!!session.name && !isLegacyAutoName(session.name)}
              >
                {(t) => (
                  <Typography sx={{ color: titleColor, fontWeight: 600, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t}
                  </Typography>
                )}
              </Typewriter>
            </InlineEditableTitle>
            {/* The welcome chat hides its 'draft' label so the title reads clean. */}
            {session.status !== 'completed' && session.status !== 'stopped' && !session.is_welcome_draft && (
              <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: c.text.tertiary, whiteSpace: 'nowrap' }}>
                  {session.queued && session.status === 'running' ? 'queued' : friendlyStatusLabel(session.status)}
                </Typography>
              </Box>
            )}
            {/* Finishing used to be signalled by the word 'working' DISAPPEARING, which is not a signal. */}
            <Fade in={session.status === 'completed' && !session.is_welcome_draft} timeout={{ enter: 260, exit: 160 }} unmountOnExit>
              <Chip
                icon={<CheckIcon sx={{ fontSize: 13, color: `${c.status.success} !important` }} />}
                label="Done"
                size="small"
                sx={{
                  bgcolor: c.status.successBg,
                  color: c.status.success,
                  border: `1px solid ${c.status.success}33`,
                  fontWeight: 600,
                  fontSize: '0.6875rem',
                  height: 22,
                  flexShrink: 0,
                  '& .MuiChip-icon': { ml: '4px' },
                }}
              />
            </Fade>
            {/* Calm, zero-click signal: the agent recalled or built up memory of
                this site, so the user feels it getting smarter on its own. */}
            <Fade in={session.memory_recalled || session.memory_learned} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
              <Tooltip title={session.memory_learned
                ? 'Saved what worked here, so it is faster next time'
                : 'Using what it learned here on a past visit'}>
                <Chip
                  icon={<AutoAwesomeIcon sx={{ fontSize: 13, color: `${accentColor} !important` }} />}
                  label={session.memory_learned ? 'Learned' : 'Remembered'}
                  size="small"
                  sx={{
                    bgcolor: c.bg.secondary,
                    color: accentColor,
                    border: `1px solid ${accentColor}33`,
                    fontWeight: 600,
                    fontSize: '0.6875rem',
                    height: 22,
                    flexShrink: 0,
                    '& .MuiChip-icon': { ml: '4px' },
                  }}
                />
              </Tooltip>
            </Fade>
          </Box>
        </Box>

        <Box
          sx={{
            display: isDraft && !expanded ? 'none' : 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            flexShrink: 0,
            minWidth: 0,
            ...(isDraft && { visibility: 'hidden' }),
          }}
        >
          <Box sx={{ display: 'flex', gap: 1.5, minWidth: 0, overflow: 'hidden' }}>
            {session.cost_usd > 0 && hasApiKey && (
              // Accent orange on a bare number read as a warning; it is just what the run cost.
              <Tooltip title="What this run has cost so far" placement="bottom-start">
                <Typography variant="caption" sx={{ color: c.text.tertiary, whiteSpace: 'nowrap' }}>
                  ${session.cost_usd.toFixed(4)}
                </Typography>
              </Tooltip>
            )}
          </Box>
        </Box>
      </Box>
      )}

      {(expanded || chatMounted) && (
        <Box
          onClick={(e) => e.stopPropagation()}
          sx={{
            mx: -2,
            mb: -2,
            mt: -2,
            flex: 1,
            minHeight: 0,
            display: expanded ? 'flex' : 'none',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: isTiled ? undefined : '20px',
          }}
        >
          <DarkTokensScope>
            {chatMounted ? (
              <AgentChat
                key={session.id}
                sessionId={session.id}
                onClose={() => dispatch(collapseSession(session.id))}
                embedded
                fullscreenChat={isFullscreen}
                autoFocus={autoFocusInput}
                isGlowing={isGlowingRedux && !glowFading}
                onDismissGlow={dismissGlow}
                onBranch={onBranch ? (newId: string) => onBranch(session.id, newId) : undefined}
              />
            ) : (
              <Box sx={{ flex: 1 }} />
            )}
          </DarkTokensScope>
        </Box>
      )}

      {!expanded && !pillMode && (
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
                  fontSize: '0.8125rem',
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
              <AskQuestionCard
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
                          fontSize: '0.6875rem',
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
                        // setAlwaysAllow so the SAME command mid-run stops re-prompting: the backend writes the policy into the live in-run snapshot, a plain allow only clears the pending request.
                        if (req.tool_name !== 'AskUserQuestion') dispatch(handleApproval({ requestId: req.id, behavior: 'allow', setAlwaysAllow: true }));
                      }
                    }}
                    sx={{
                      bgcolor: c.status.success,
                      '&:hover': { bgcolor: '#1e4d15' },
                      fontWeight: 600,
                      fontSize: '0.75rem',
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
                      fontSize: '0.75rem',
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

/** Self-subscribing wrapper; each card reads only its own session+position so streaming to A doesn't disturb B. */
const AgentCardOuter: React.FC<OuterProps> = (props) => {
  const session = useAppSelector((s) => s.agents.sessions[props.sessionId]);
  const cardEntry = useAppSelector((s) => s.dashboardLayout.cards[props.sessionId]);
  const zOverride = useAppSelector((s) => s.dashboardLayout.zOrders[props.sessionId]);
  if (!session || !cardEntry) return null;
  return (
    <MemoAgentCard
      {...props}
      session={session}
      cardX={cardEntry.x}
      cardY={cardEntry.y}
      cardWidth={cardEntry.width}
      cardHeight={cardEntry.height}
      cardZOrder={zOverride ?? cardEntry.zOrder ?? 0}
    />
  );
};

export default AgentCardOuter;
