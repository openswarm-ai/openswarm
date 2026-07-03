import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import Fade from '@mui/material/Fade';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckIcon from '@mui/icons-material/Check';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { friendlyStatusLabel } from '@/shared/statusLabel';
import { openSettingsModal, dismissMcpSuggestion } from '@/shared/state/settingsSlice';
import { API_BASE, getAuthToken } from '@/shared/config';
import {
  sendMessage as sendMessageThunk,
  launchAndSendFirstMessage,
  generateTitle,
  generateGroupMeta,
  stopAgent,
  handleApproval,
  editMessage,
  switchBranch,
  duplicateSession,
  setActiveSession,
  updateSessionModel,
  clearContextOverflow,
  updateSessionMode,
  updateSessionThinkingLevel,
  updateThinkingLevel,
  fetchSession,
  AgentMessage,
  clearSessionMessages,
  clearMcpSuggestions,
} from '@/shared/state/agentsSlice';
import { displayChatTitle, isLegacyAutoName } from '@/shared/state/sessionDisplay';
import { Typewriter } from '@/app/components/feedback/Animated';
import { store } from '@/shared/state/store';
import { fetchModes } from '@/shared/state/modesSlice';
import { createSessionWs, acquireSessionWs, releaseSessionWs } from '@/shared/ws/WebSocketManager';
import StreamingBubble from './bubbles/StreamingBubble';
import WelcomeQuickReplies from './WelcomeQuickReplies';
import { useWelcomeGreeting } from './useWelcomeGreeting';
import { THINKING_LABELS } from './thinkingLabels';
import MessageBubble from './bubbles/MessageBubble';
import { estimateRenderedTextHeight, RECHECK_VISIBILITY_EVENT } from './bubbles/markdownMeasure';
import CompactionMarker from './bubbles/CompactionMarker';
import MessageActionBar from './shell/MessageActionBar';
import ToolCallBubble, { ToolPair } from './tool-bubbles/ToolCallBubble';
import ToolGroupBubble, { RenderItem, ToolGroup, isToolGroup, isToolPair } from './tool-bubbles/ToolGroupBubble';
import ApprovalBar, { BatchApprovalBar } from './shell/ApprovalBar';
import ForceStopAgentBar from './ForceStopAgentBar';
import { RateLimitPill } from './shell/RateLimitPill';
import ChatInput, { ChatInputHandle } from './ChatInput';
import ContextDrawer from './shell/ContextDrawer';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { setGlowingBrowserCards, fadeGlowingBrowserCards, clearGlowingBrowserCards, removeCard } from '@/shared/state/dashboardLayoutSlice';
import type { WorkflowsRunContext } from '@/shared/state/dashboardLayoutSlice';
import { setCardSidecar, commitDraft, updateWorkflowCard, controlWorkflowRun } from '@/shared/state/workflowsSlice';
import { shallowEqual } from 'react-redux';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { parseMcpToolName, getMcpInputSummary } from '@/shared/mcpToolMeta';

const CONTEXT_WINDOWS: Record<string, number> = {
  'opus-4-8': 1_000_000,
  'opus-4-7': 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
};

// Only a fallback for never-rendered items; real heights are measured once on screen.
const RENDER_ITEM_ESTIMATED_HEIGHT = 140;
// Conservative estimate for an unmeasured tool row: tool groups/pairs render collapsed (~40-50px) far more often than expanded. Leaning low keeps scrollHeight (and the scrollbar thumb) from jumping when a tool row measures shorter.
const COLLAPSED_TOOL_ROW_HEIGHT = 44;
// How many screens of real content to keep mounted on EACH side of the viewport. Beyond it, items unmount and are replaced by a measured-height spacer, so render/memory stays bounded no matter how long the transcript is.
const WINDOW_BUFFER_SCREENS_PER_SIDE = 3;
// Below this item count the transcript renders WHOLE, no spacers, no windowing. Virtualization only earns its keep on huge chats; on a normal chat the spacer-height recompute just fights the scroll position (the "jumps up and down" glitch), so we skip it entirely until a chat is genuinely long.
const WINDOW_MIN_ITEMS = 60;
// Floor on the mounted item count so a single very tall item can't strand us with an effectively empty window.
const MIN_WINDOW_BUFFER_ITEMS = 6;

// Bootstrap count for the initial bottom-anchored slice (on open and on scroll-to-bottom): enough rows to cover the viewport + buffer using the same row-height estimate the solver uses, floored. It's only a seed — the pixel solver (computeDesiredWindow) refines the window to exact from measured heights on the next frame, so this never needs to be precise.
function initialSeedItems(viewportHeight: number): number {
  const fillPx = (1 + WINDOW_BUFFER_SCREENS_PER_SIDE) * Math.max(1, viewportHeight);
  return Math.max(MIN_WINDOW_BUFFER_ITEMS, Math.ceil(fillPx / RENDER_ITEM_ESTIMATED_HEIGHT));
}

// Pure window solver: given the current scroll position and a per-index height accessor (measured where known, estimated otherwise), return the [start, end) slice of render items that should be mounted. The buffer is measured in PIXELS (N screens of real content on each side of the viewport), not item count, so a few very tall messages can't blow the mounted set up to the whole transcript. A huge viewport naturally yields start=0/end=total (mount all).
function computeDesiredWindow(
  scrollTop: number,
  clientHeight: number,
  total: number,
  heightOf: (index: number) => number,
  bufferPx: number,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const keepTop = scrollTop - bufferPx;
  const keepBottom = scrollTop + clientHeight + bufferPx;
  let offset = 0;
  let start = -1;
  let end = total;
  for (let i = 0; i < total; i++) {
    const h = heightOf(i);
    const itemTop = offset;
    const itemBottom = offset + h;
    if (start === -1 && itemBottom > keepTop) start = i;
    if (itemTop < keepBottom) {
      end = i + 1;
    } else {
      // Everything past here starts below the keep band.
      break;
    }
    offset += h;
  }
  if (start === -1) start = Math.max(0, total - 1);
  end = Math.min(total, Math.max(end, start + 1));
  // Always keep at least a small floor of items mounted around the viewport so a single under-measured item can't strand us with an empty window.
  if (end - start < MIN_WINDOW_BUFFER_ITEMS) {
    start = Math.max(0, Math.min(start, end - MIN_WINDOW_BUFFER_ITEMS));
  }
  return { start: Math.max(0, start), end };
}

function stringifyContent(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

// Content-aware height estimate for a render item that has never been measured. Tool rows and tiny system/thinking rows keep the flat fallback; message bubbles scale with their FULL text length (messages render in full once on-screen, so the estimate matches both the rendered bubble and MessageBubble's placeholder fallback).
function estimateItemHeight(item: RenderItem, viewportWidth: number): number {
  if (isToolGroup(item) || isToolPair(item)) return COLLAPSED_TOOL_ROW_HEIGHT;
  const msg = item as AgentMessage;
  if (msg.role === 'thinking' || msg.role === 'system') return 60;
  return estimateRenderedTextHeight(stringifyContent(msg.content), viewportWidth);
}

const thinkingShimmerKeyframes = `
@keyframes thinking-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
`;

// Pick a label deterministically per session-turn so the pill has variety without flickering between renders. Shared list with MessageBubble.
function streamingLabelFor(seedKey: string | undefined): string {
  if (!seedKey) return THINKING_LABELS[0].live;
  let h = 0;
  for (let i = 0; i < seedKey.length; i++) {
    h = ((h << 5) - h + seedKey.charCodeAt(i)) | 0;
  }
  return THINKING_LABELS[Math.abs(h) % THINKING_LABELS.length].live;
}

const ThinkingBubble: React.FC<{ label?: string | null; seedKey?: string }> = ({ label, seedKey }) => {
  const c = useClaudeTokens();
  const shimmerBase = c.text.tertiary;
  const shimmerHighlight = c.text.primary;
  // Aux-LLM label wins; otherwise pick a quirky verb keyed off seedKey so different sessions / turns show different verbs without flicker.
  const display = label ? `${label}…` : `${streamingLabelFor(seedKey)}…`;
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start', my: 0.75 }}>
      <style>{thinkingShimmerKeyframes}</style>
      <Box
        sx={{
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.subtle}`,
          borderRadius: '16px 16px 16px 4px',
          px: 2,
          py: 1.5,
          boxShadow: c.shadow.sm,
          display: 'flex',
          alignItems: 'center',
          minHeight: 36,
        }}
      >
        <Box
          component="span"
          sx={{
            fontSize: '0.85rem',
            fontWeight: 500,
            background: `linear-gradient(90deg, ${shimmerBase} 0%, ${shimmerBase} 40%, ${shimmerHighlight} 50%, ${shimmerBase} 60%, ${shimmerBase} 100%)`,
            backgroundSize: '200% 100%',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            color: 'transparent',
            animation: 'thinking-shimmer 2s linear infinite',
            transition: 'opacity 0.25s',
          }}
        >
          {display}
        </Box>
      </Box>
    </Box>
  );
};

interface QueuedMessage {
  prompt: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  selectedBrowserIds?: string[];
  selectedAppIds?: string[];
  attachedRunId?: string;
  selectedSettingIds?: string[];
}

interface AgentChatProps {
  sessionId?: string;
  onClose?: () => void;
  embedded?: boolean;
  autoFocus?: boolean;
  isGlowing?: boolean;
  onDismissGlow?: () => void;
  initialContextPaths?: ContextPath[];
  onBranch?: (newSessionId: string) => void;
  // Set when this chat is the workflow build/edit agent: the out-of-tokens card then warns that switching models here also changes the workflow's run model.
  workflowEditId?: string;
  // View-only transcript (e.g. the Run Monitor): renders messages + tool calls but no composer, so the session can't be typed into.
  readOnly?: boolean;
  // One-shot text to drop into the composer (e.g. a run attached as context).
  prefillPrompt?: string;
  // A workflow run attached as a removable context chip above the composer; while present, each send routes through onSendRunQuestion so the run's transcript rides along as hidden context for that turn.
  runContext?: WorkflowsRunContext;
  onClearRunContext?: () => void;
  onSendRunQuestion?: (prompt: string, runId: string) => Promise<void>;
}

const AgentChat: React.FC<AgentChatProps> = ({ sessionId: sessionIdProp, onClose, embedded, autoFocus, isGlowing, onDismissGlow, initialContextPaths, onBranch, workflowEditId, readOnly, prefillPrompt, runContext, onClearRunContext, onSendRunQuestion }) => {
  const c = useClaudeTokens();
  const STATUS_STYLES: Record<string, { color: string; bg: string }> = {
    running: { color: c.status.success, bg: c.status.successBg },
    waiting_approval: { color: c.status.warning, bg: c.status.warningBg },
    completed: { color: c.text.tertiary, bg: c.bg.secondary },
    error: { color: c.status.error, bg: c.status.errorBg },
    stopped: { color: c.text.tertiary, bg: c.bg.secondary },
  };
  const { id: routeId } = useParams<{ id: string }>();
  const id = sessionIdProp || routeId;
  // A card linked as a workflow sidecar (Test Agent, or a watched run) swaps its composer for a Force Stop button: continuing the chat is meaningless, but killing the run is the common need. Once a Test Agent finishes, the button flips to a green "close" (see workflow_test_state + ForceStopAgentBar).
  const linkedSidecar = useAppSelector((s) => {
    const found = Object.values(s.workflows.openCards).find(
      (cd) => cd.sidecarSessionId === id && (cd.sidecarKind === 'testing' || cd.sidecarKind === 'watching'),
    );
    return found
      ? { workflowId: found.workflowId, runId: found.runId ?? null, kind: found.sidecarKind ?? null }
      : null;
  }, shallowEqual);
  const linkedWorkflowId = linkedSidecar?.workflowId ?? null;
  const isStoppableSidecar = !!linkedWorkflowId;
  // A live workflow run being watched owns pause/resume from its workflow card, so the chat's own "Resume Agent Response" bubble is redundant and would go stale against the card's Resume. Suppress it for any workflow-run sidecar, not just the fragile exact "watching" value. Test-run sidecars keep their chat-level resume behavior.
  const isWorkflowRunSidecar = useAppSelector((s) => {
    if (!id) return false;
    for (const cd of Object.values(s.workflows.openCards)) {
      if (cd.sidecarSessionId !== id || cd.sidecarKind === 'testing') continue;
      if (cd.runId) {
        const run = (s.workflows.runs[cd.workflowId] || []).find((r) => r.id === cd.runId);
        if (!run || run.session_id === id) return true;
      }
      if (cd.sidecarKind === 'watching' || cd.sidecarKind === 'viewing-completed' || cd.sidecarKind === 'viewing-error') return true;
    }
    return Object.values(s.workflows.runs).some((runs) =>
      runs.some((r) => r.session_id === id && r.status === 'running'),
    );
  });
  const testState = useAppSelector((s) => (id ? s.agents.sessions[id]?.workflow_test_state : null) ?? null);
  const dispatch = useAppDispatch();
  const session = useAppSelector((state) => (id ? state.agents.sessions[id] : undefined));
  const modesMap = useAppSelector((state) => state.modes.items);
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);
  const connectionMode = useAppSelector((state) => state.settings.data.connection_mode);

  // Stored value → curated picker label, with a tidy fallback for unknowns.
  const resolveModelLabel = useCallback((value: string | null | undefined): string => {
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
  }, [modelsByProvider]);
  // Used by the "too many connected apps for Haiku" warning rendered above ChatInput. Each connected MCP adds a meaningful chunk of tool-schema tokens to every request; Haiku 4.5's 200K window can't hold 5+ of them.
  const toolItems = useAppSelector((state) => state.tools.items);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastVisibleItemRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const isAtBottomRef = useRef(true);
  const pendingInitialBottomScrollRef = useRef(false);
  const initialBottomScrollSettledRef = useRef(false);
  const renderItemsLengthRef = useRef(0);
  const renderItemsRef = useRef<RenderItem[]>([]);
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const estimateCacheRef = useRef<Map<string, number>>(new Map());
  const viewportWidthRef = useRef(0);
  const windowStartRef = useRef(0);
  const windowEndRef = useRef(0);
  const windowScrollRafRef = useRef<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [windowEnd, setWindowEnd] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showResumeBubble, setShowResumeBubble] = useState(false);
  useEffect(() => {
    if (isWorkflowRunSidecar) setShowResumeBubble(false);
  }, [isWorkflowRunSidecar]);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [preSendActivityLabel, setPreSendActivityLabel] = useState<string | null>(null);
  const [activatingMcp, setActivatingMcp] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  // Holds the last non-empty suggestions so the docked banner's exit fade renders them instead of going blank the instant the array is cleared.
  const mcpSnapshotRef = useRef<Array<{ id: string; title: string; description: string; reason?: string }>>([]);
  const [mode, setMode] = useState('agent');
  const [model, setModel] = useState('sonnet');
  // Workflow build chat only: brief "this model now runs the workflow" notice when the user switches models, so the run-model change isn't silent.
  const [workflowModelNotice, setWorkflowModelNotice] = useState<string | null>(null);
  const workflowModelNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [freeTrialModelNotice, setFreeTrialModelNotice] = useState<{ kind: 'connect' | 'spent'; label: string } | null>(null);
  const freeTrialModelNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const freeTrialRemaining = useAppSelector((s) => s.settings.data.free_trial_remaining);

  // Read live in the stable handleSend/dispatchMessage closures without busting their memo (ChatInput leans on handleSend identity holding across renders).
  const runContextRef = useRef(runContext);
  runContextRef.current = runContext;
  const onSendRunQuestionRef = useRef(onSendRunQuestion);
  onSendRunQuestionRef.current = onSendRunQuestion;

  const wsRef = useRef<ReturnType<typeof createSessionWs> | null>(null);
  // Current status for the WS-cleanup closure (effect deps can't include it).
  const statusRef = useRef<string | undefined>(undefined);
  const initialContextApplied = useRef(false);
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);

  const isDraft = session?.status === 'draft';
  const { greetingDone: welcomeGreetingDone } = useWelcomeGreeting(session, isDraft);

  useEffect(() => {
    if (!id || isDraft) return;
    let cancelled = false;
    let ws: ReturnType<typeof createSessionWs> | null = null;
    // Order matters: hydrate the persisted message list from REST FIRST, THEN connect the WS. The WS resume protocol replays buffered events starting at last_seq=0, which includes every stream_* event for messages that finished before the disconnect. The replay-skip guard in WebSocketManager._messageAlreadyComplete checks `session.messages` to decide whether to drop deltas, so if we connect first, the slice is empty when the replay arrives, the guard returns false, and the user sees the chat type itself out again. Awaiting fetchSession before connect makes the slice authoritative before any replay event lands.
    (async () => {
      // The await exists so the slice isn't EMPTY at replay time. A warm store (remount after a hop) already satisfies that, so connect immediately and let the fetch reconcile in the background; awaiting serialized a slow round trip in front of the live stream on every reopen.
      const warm = !!store.getState().agents.sessions[id]?.messages?.length;
      if (warm) {
        dispatch(fetchSession(id));
      } else {
        try {
          await dispatch(fetchSession(id));
        } catch {
          // Even if the REST hydrate fails, still connect, the WS resume protocol can hydrate from buffered events as a fallback.
        }
      }
      if (cancelled) return;
      // acquireSessionWs reuses a still-open socket kept alive from the last hop, so an active agent's stream resumes with no reconnect handshake. connect() is a no-op when the reused socket is already open.
      ws = acquireSessionWs(id);
      ws.connect();
      wsRef.current = ws;
    })();
    return () => {
      cancelled = true;
      if (ws) {
        const st = statusRef.current;
        const active = st === 'running' || st === 'waiting_approval';
        releaseSessionWs(id, ws, active);
      }
      wsRef.current = null;
    };
  }, [id, isDraft, dispatch]);

  useEffect(() => {
    if (initialContextApplied.current || !initialContextPaths?.length) return;
    const timer = setTimeout(() => {
      chatInputRef.current?.setContent('', initialContextPaths);
      initialContextApplied.current = true;
    }, 50);
    return () => clearTimeout(timer);
  }, [initialContextPaths]);

  useEffect(() => {
    if (session) setMode(session.mode);
  }, [session?.mode]);

  useEffect(() => {
    if (session) setModel(session.model);
  }, [session?.model]);

  useEffect(() => {
    if (Object.keys(modesMap).length === 0) dispatch(fetchModes());
  }, [dispatch, modesMap]);

  const dispatchMessage = useCallback((msg: QueuedMessage) => {
    if (!id) return;
    setShowResumeBubble(false);
    setAwaitingResponse(true);
    if (isDraft) {
      const config: Record<string, any> = { model, mode };
      if (session?.system_prompt) config.system_prompt = session.system_prompt;
      if (session?.target_directory) config.target_directory = session.target_directory;
      // Carry the draft's dashboard so the launched session stays ON this dashboard; without it the session lands dashboard_id=null, drops out of the reconcile filter, and its card vanishes the instant you send (looked like "the chat quit when I clicked an option").
      if (session?.dashboard_id) config.dashboard_id = session.dashboard_id;
      // Editing an existing app: bind the launch to it so the backend edits in place instead of seeding a duplicate empty app (App Builder mode only).
      if (msg.selectedAppIds?.length) config.selected_app_output_ids = msg.selectedAppIds;
      dispatch(
        launchAndSendFirstMessage({ draftId: id, config, prompt: msg.prompt, mode, model, images: msg.images, contextPaths: msg.contextPaths, forcedTools: msg.forcedTools, attachedSkills: msg.attachedSkills, selectedBrowserIds: msg.selectedBrowserIds, selectedAppIds: msg.selectedAppIds, selectedSettingIds: msg.selectedSettingIds })
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt: msg.prompt }));
          if (msg.selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));
          }
        }
      });
    } else if (msg.attachedRunId && onSendRunQuestionRef.current) {
      // Run-context question: the backend folds the run transcript into this one turn and echoes the user bubble + answer over WS, so no optimistic thunk.
      onSendRunQuestionRef.current(msg.prompt, msg.attachedRunId).catch(() => setAwaitingResponse(false));
    } else {
      if (msg.selectedBrowserIds?.length) {
        dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: id, label: 'Use Browser' }));
      }
      dispatch(sendMessageThunk({ sessionId: id, prompt: msg.prompt, mode, model, images: msg.images, contextPaths: msg.contextPaths, forcedTools: msg.forcedTools, attachedSkills: msg.attachedSkills, selectedBrowserIds: msg.selectedBrowserIds, selectedAppIds: msg.selectedAppIds, selectedSettingIds: msg.selectedSettingIds }))
        .then((action) => {
          if (sendMessageThunk.rejected.match(action)) {
            setAwaitingResponse(false);
          }
        });
    }
  }, [id, isDraft, mode, model, session?.system_prompt, session?.target_directory, session?.dashboard_id, dispatch]);

  statusRef.current = session?.status;

  const agentBusy = awaitingResponse || (!isDraft && (session?.status === 'running' || session?.status === 'waiting_approval'));

  const prevStatusRef = useRef(session?.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = session?.status;
    prevStatusRef.current = curr;
    let didDispatchQueued = false;

    const wasActive = prev === 'running' || prev === 'waiting_approval';
    const isTerminal = curr === 'completed' || curr === 'stopped' || curr === 'error';

    if (wasActive && isTerminal) {
      if (id) {
        dispatch(fadeGlowingBrowserCards(id));
        setTimeout(() => dispatch(clearGlowingBrowserCards(id)), 600);
      }

      const nextQueued = messageQueueRef.current.shift();
      if (nextQueued) {
        setQueueLength(messageQueueRef.current.length);
        dispatchMessage(nextQueued);
        didDispatchQueued = true;
      } else {
        if (curr === 'stopped') {
          setShowResumeBubble(!isWorkflowRunSidecar);
        }
      }

      const currentMode = modesMap[mode];
      if (currentMode?.default_next_mode && modesMap[currentMode.default_next_mode]) {
        setMode(currentMode.default_next_mode);
        if (id && !isDraft) {
          dispatch(updateSessionMode({ sessionId: id, mode: currentMode.default_next_mode as any }));
        }
      }
    }
    if (curr === 'running') {
      setShowResumeBubble(false);
    }
    if (curr !== 'draft' && !didDispatchQueued) {
      setAwaitingResponse(false);
    }
  }, [session?.status, mode, modesMap, id, isDraft, dispatch, dispatchMessage, isWorkflowRunSidecar]);

  // A reload remounts past the live running->stopped transition that first shows the resume button, so re-derive it once from the persisted 'stopped' status (transcript-gated so a cleared chat can't resurrect it).
  const resumeHydratedRef = useRef(false);
  useEffect(() => {
    if (resumeHydratedRef.current) return;
    if (session?.status === 'stopped' && (session?.messages?.length ?? 0) > 0) {
      resumeHydratedRef.current = true;
      setShowResumeBubble(true);
    }
  }, [session?.status, session?.messages?.length]);

  // Idle reconcile: if the session has been 'running' for 5s with no WebSocket activity (no new messages, no streaming updates), do a single GET to fetch the real status from the backend. Catches the case where the completion WebSocket event was dropped (network blip, sleep/wake, SDK subprocess dying). Resets on every activity signal so it never fires during normal streaming.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageCount = session?.messages?.length ?? 0;
  // Subscribe only to the streaming MESSAGE ID (stable across the 30Hz delta updates), never to the content. The actual streaming text renders inside the leaf <StreamingBubble> below, which subscribes to the content itself. This keeps AgentChat's render and useEffects dormant during streaming; only the bubble updates per delta.
  const streamingMessageId = useAppSelector((s) => id ? s.streaming.bySession[id]?.id ?? null : null);
  const hasStreaming = !!streamingMessageId;

  useEffect(() => {
    if (
      streamingMessageId ||
      session?.turn_label?.label ||
      session?.status === 'completed' ||
      session?.status === 'error' ||
      session?.status === 'stopped'
    ) {
      setPreSendActivityLabel(null);
    }
  }, [streamingMessageId, session?.turn_label?.label, session?.status]);

  useEffect(() => {
    if (reconcileTimer.current) {
      clearTimeout(reconcileTimer.current);
      reconcileTimer.current = null;
    }

    if (!id || session?.status !== 'running') return;

    reconcileTimer.current = setTimeout(() => {
      reconcileTimer.current = null;
      dispatch(fetchSession(id));
    }, 5000);

    return () => {
      if (reconcileTimer.current) {
        clearTimeout(reconcileTimer.current);
        reconcileTimer.current = null;
      }
    };
  }, [id, session?.status, messageCount, hasStreaming, dispatch]);

  const SCROLL_THRESHOLD = 50;

  // Reserved pixel height for a render item: the measured height once we have one, otherwise a content-aware estimate (cached per id). The spacer math and the window solver both go through this so unmounted spacers, freshly-mounted placeholders, and the real rendered bubble all reserve the same space.
  const reservedHeightForItem = useCallback((item: RenderItem | undefined): number => {
    if (!item) return RENDER_ITEM_ESTIMATED_HEIGHT;
    const measured = itemHeightsRef.current.get(item.id);
    if (measured != null) return measured;
    const cached = estimateCacheRef.current.get(item.id);
    if (cached != null) return cached;
    const est = estimateItemHeight(item, viewportWidthRef.current);
    estimateCacheRef.current.set(item.id, est);
    return est;
  }, []);

  // Measured-or-estimated pixel height of render item at `index`, for the window solver (reads the renderItems ref so it is valid inside rAF callbacks).
  const heightOf = useCallback((index: number): number => {
    return reservedHeightForItem(renderItemsRef.current[index]);
  }, [reservedHeightForItem]);

  // Solve the mounted window from the live scroll position and push it to state when it changes. Scroll position itself is preserved by the container's overflow-anchor plus the measured-height spacers, so we never touch scrollTop here. Following (pinned to bottom) always keeps the newest item.
  const applyWindowFromScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (!initialBottomScrollSettledRef.current) return;
    const total = renderItemsLengthRef.current;
    // Below the windowing threshold the whole transcript is mounted; recomputing a window here would only churn the spacers and shift scroll. Leave it alone.
    if (total < WINDOW_MIN_ITEMS) return;
    const clientHeight = Math.max(1, el.clientHeight);
    const tightPx = WINDOW_BUFFER_SCREENS_PER_SIDE * clientHeight;
    // Mount with the tight buffer, but keep already-mounted items until they drift a full extra screen past it. Without this, an item sitting right on the buffer edge flip-flops mounted/unmounted forever: mounting it shifts content above the viewport, overflow-anchor nudges scrollTop a few px, that re-runs the solver, which now excludes it, and round it goes.
    const loosePx = tightPx + clientHeight;
    const tight = computeDesiredWindow(el.scrollTop, clientHeight, total, heightOf, tightPx);
    const loose = computeDesiredWindow(el.scrollTop, clientHeight, total, heightOf, loosePx);
    const curStart = windowStartRef.current;
    const curEnd = windowEndRef.current;
    // Must-mount the tight band; keep current edges only while still inside loose.
    let start = Math.max(loose.start, Math.min(curStart, tight.start));
    let end = Math.min(loose.end, Math.max(curEnd, tight.end));
    if (isAtBottomRef.current) end = total;
    start = Math.max(0, Math.min(start, Math.max(0, end - 1)));
    if (start === curStart && end === curEnd) return;
    windowStartRef.current = start;
    windowEndRef.current = end;
    setWindowStart(start);
    setWindowEnd(end);
  }, [heightOf]);

  const scheduleWindowRecompute = useCallback(() => {
    if (windowScrollRafRef.current != null) return;
    windowScrollRafRef.current = requestAnimationFrame(() => {
      windowScrollRafRef.current = null;
      applyWindowFromScroll();
    });
  }, [applyWindowFromScroll]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setScrollRoot(el);

    const updateViewport = () => {
      setViewportHeight(el.clientHeight);
      setViewportWidth(el.clientWidth);
      // Width drives the char-per-line estimate; drop cached estimates so they recompute at the new width (measured heights are unaffected and kept).
      estimateCacheRef.current.clear();
      // Resize changes the budgets and how many items fit; re-solve the window off the current scroll position WITHOUT resetting it (only session / branch changes reset). overflow-anchor holds the visible content.
      scheduleWindowRecompute();
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (windowScrollRafRef.current != null) {
        cancelAnimationFrame(windowScrollRafRef.current);
        windowScrollRafRef.current = null;
      }
      setScrollRoot(null);
    };
  }, [id, session?.id, scheduleWindowRecompute]);

  React.useLayoutEffect(() => {
    const seed = initialSeedItems(viewportHeight);
    const total = renderItemsLengthRef.current;
    const end = total;
    const start = Math.max(0, end - seed);
    windowStartRef.current = start;
    windowEndRef.current = end;
    setWindowStart(start);
    setWindowEnd(end);
    itemHeightsRef.current.clear();
    estimateCacheRef.current.clear();
    if (initialPinRafRef.current != null) {
      cancelAnimationFrame(initialPinRafRef.current);
      initialPinRafRef.current = null;
    }
    pendingInitialBottomScrollRef.current = true;
    initialBottomScrollSettledRef.current = false;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, [id, session?.active_branch_id]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Measure against the real content bottom, not the locked-height pad below it.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
    // Slide the mounted window to follow the viewport (loads newer/older items and unloads ones that drifted past the buffer on either side).
    scheduleWindowRecompute();
  }, [scheduleWindowRecompute]);

  // Prevent scroll from leaking into the dashboard canvas when at boundaries
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Pinch-to-zoom (ctrl/meta + wheel) must reach the canvas viewport so the dashboard zooms when the cursor is over an agent's chat panel. Without this early-out the unconditional stopPropagation below kills ctrl+wheel and the canvas listener never fires.
      if (e.ctrlKey || e.metaKey) return;
      // Horizontal-dominant gestures must also reach the canvas so a sideways swipe pans the dashboard (chat has no horizontal scroll to absorb).
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
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

  const scrollToBottomRafRef = useRef<number | null>(null);
  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    // When scrolled far up the newest items are unmounted behind the bottom spacer (estimated height). Jump the window to the bottom slice so they actually mount, then pin across several frames: a single scrollTop=scrollHeight lands short because the spacer collapses and the freshly-mounted items replace their estimates with real measured heights, changing scrollHeight.
    const total = renderItemsLengthRef.current;
    const start = Math.max(0, total - initialSeedItems(el.clientHeight));
    windowStartRef.current = start;
    windowEndRef.current = total;
    setWindowStart(start);
    setWindowEnd(total);
    if (scrollToBottomRafRef.current != null) cancelAnimationFrame(scrollToBottomRafRef.current);
    let frame = 0;
    const FRAMES = 16; // ~260ms, enough for the window + oversized blocks to settle
    const pin = () => {
      const c = scrollContainerRef.current;
      if (!c) { scrollToBottomRafRef.current = null; return; }
      c.scrollTop = c.scrollHeight;
      lastScrollHeightRef.current = c.scrollHeight;
      isAtBottomRef.current = true;
      if (++frame < FRAMES) {
        scrollToBottomRafRef.current = requestAnimationFrame(pin);
      } else {
        scrollToBottomRafRef.current = null;
        // Jump has settled: re-evaluate oversized message / block visibility synchronously so nothing now in view is stuck as a placeholder.
        c.dispatchEvent(new CustomEvent(RECHECK_VISIBILITY_EVENT));
      }
    };
    pin();
  }, []);

  const scrollRafRef = useRef<number | null>(null);
  const pinRafRef = useRef<number | null>(null);
  const initialPinRafRef = useRef<number | null>(null);
  const lastScrollHeightRef = useRef<number>(0);
  // Shared scroll-stick routine. Used both by the structural-events useEffect below (new message lands / stream starts/ends) and by StreamingBubble's onStreamGrew callback (per-delta growth). RAF + height-grew gate ensures we only set scrollTop when needed.
  const stickToBottomIfNeeded = useCallback(() => {
    if (!isAtBottomRef.current) return;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!isAtBottomRef.current) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      const newHeight = el.scrollHeight;
      if (newHeight === lastScrollHeightRef.current) return;
      lastScrollHeightRef.current = newHeight;
      el.scrollTop = newHeight;
    });
  }, []);
  useEffect(() => {
    stickToBottomIfNeeded();
    // Structural triggers only: a new message lands or a stream starts/ends. Streaming content updates trigger this via <StreamingBubble onStreamGrew={stickToBottomIfNeeded} /> instead so AgentChat stays dormant during the 30Hz delta storm.
  }, [session?.messages.length, streamingMessageId, stickToBottomIfNeeded]);

  // Stream-end re-stick. When a stream finishes, the live bubble (smooth-revealed text) is replaced by the committed bubble rendering FULL markdown with contentVisibility placeholders; as those resolve, Chromium's overflow-anchor re-anchors to an EARLIER element (the user message), yanking the view up to "the top of the user input". A single deferred scroll loses the race because that anchor shift fires an onScroll that flips isAtBottomRef false before we run. Fix: snapshot the "was following" intent the moment streaming stops (captured continuously during the stream, before any completion re-render), then pin to bottom across a short multi-frame window that OVERRIDES the layout-induced flip. A genuine user scroll-away (wheel/touch) during that window aborts the pin, honoring "unless the user scrolls up".
  const prevStreamingIdRef = useRef<string | null>(null);
  const wasFollowingRef = useRef(true);
  const pinAbortRef = useRef(false);
  // Keep the follow-intent fresh while streaming so it's accurate at the instant the stream ends (handleScroll updates isAtBottomRef on every real scroll).
  if (streamingMessageId) wasFollowingRef.current = isAtBottomRef.current;
  useEffect(() => {
    const prev = prevStreamingIdRef.current;
    prevStreamingIdRef.current = streamingMessageId;
    if (!(prev && !streamingMessageId)) return;
    if (!wasFollowingRef.current) return; // user had scrolled up; leave them be
    pinAbortRef.current = false;
    const el = scrollContainerRef.current;
    if (!el) return;
    // Abort the pin only on a deliberate scroll-away gesture, not the layout-induced onScroll the commit itself triggers.
    const onUserScrollAway = (e: Event) => {
      if ((e as WheelEvent).deltaY != null && (e as WheelEvent).deltaY < 0) pinAbortRef.current = true; // wheel up
      else if (e.type === 'touchmove') pinAbortRef.current = true;
    };
    el.addEventListener('wheel', onUserScrollAway, { passive: true });
    el.addEventListener('touchmove', onUserScrollAway, { passive: true });
    let frame = 0;
    const FRAMES = 18; // ~300ms at 60fps, long enough for async highlight/layout
    const pin = () => {
      if (pinAbortRef.current) { cleanup(); return; }
      const c = scrollContainerRef.current;
      if (c) { c.scrollTop = c.scrollHeight; lastScrollHeightRef.current = c.scrollHeight; isAtBottomRef.current = true; }
      if (++frame < FRAMES) { pinRafRef.current = requestAnimationFrame(pin); }
      else cleanup();
    };
    const cleanup = () => {
      el.removeEventListener('wheel', onUserScrollAway);
      el.removeEventListener('touchmove', onUserScrollAway);
      if (pinRafRef.current != null) { cancelAnimationFrame(pinRafRef.current); pinRafRef.current = null; }
    };
    pinRafRef.current = requestAnimationFrame(pin);
    return cleanup;
  }, [streamingMessageId]);

  // A tool's live pill is already on screen when it commits, so re-running the mount reveal on the committed bubble flashes the exact same row. Remember the id that just stopped streaming for a beat and let that one bubble skip its entrance, so the hand-off is seamless. 500ms is slack for the commit render to land after the stream clears (they don't always arrive on the same frame).
  const [justStreamedId, setJustStreamedId] = useState<string | null>(null);
  const justStreamPrevRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = justStreamPrevRef.current;
    justStreamPrevRef.current = streamingMessageId;
    if (prev && !streamingMessageId) {
      setJustStreamedId(prev);
      const t = setTimeout(() => setJustStreamedId(null), 500);
      return () => clearTimeout(t);
    }
  }, [streamingMessageId]);

  useEffect(() => () => {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (pinRafRef.current != null) {
      cancelAnimationFrame(pinRafRef.current);
      pinRafRef.current = null;
    }
    if (initialPinRafRef.current != null) {
      cancelAnimationFrame(initialPinRafRef.current);
      initialPinRafRef.current = null;
    }
    if (scrollToBottomRafRef.current != null) {
      cancelAnimationFrame(scrollToBottomRafRef.current);
      scrollToBottomRafRef.current = null;
    }
  }, []);

  // useCallback so ChatInput's memo equality holds across AgentChat re-renders driven by unrelated session state. Captures agentBusy through the dependency so a stale "busy" closure doesn't ever route a message past the queue.
  const handleSend = useCallback(
    (
      prompt: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>,
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
      selectedAppIds?: string[],
      selectedSettingIds?: string[],
    ) => {
      if (!id) return;
      scrollToBottom();
      const msg: QueuedMessage = { prompt, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds, selectedAppIds, selectedSettingIds, attachedRunId: runContextRef.current?.runId };
      if (agentBusy) {
        messageQueueRef.current.push(msg);
        setQueueLength(messageQueueRef.current.length);
        return;
      }
      dispatchMessage(msg);
    },
    [id, scrollToBottom, agentBusy, dispatchMessage],
  );

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    if (id && !isDraft) dispatch(updateSessionMode({ sessionId: id, mode: newMode }));
  }, [id, isDraft, dispatch]);

  const handleModelChange = useCallback((newModel: string) => {
    // On the trial only Haiku is funded; picking anything else needs a connected provider, and once runs are spent nothing local works, so warn and keep the funded model instead of snagging.
    if (connectionMode === 'free-trial') {
      const kind: 'connect' | 'spent' | null =
        (freeTrialRemaining ?? 0) <= 0 ? 'spent' : (newModel !== 'haiku' ? 'connect' : null);
      if (kind) {
        setFreeTrialModelNotice({ kind, label: resolveModelLabel(newModel) });
        if (freeTrialModelNoticeTimer.current) clearTimeout(freeTrialModelNoticeTimer.current);
        freeTrialModelNoticeTimer.current = setTimeout(() => setFreeTrialModelNotice(null), 6000);
        return;
      }
    }
    if (workflowEditId && newModel !== model) {
      setWorkflowModelNotice(resolveModelLabel(newModel));
      if (workflowModelNoticeTimer.current) clearTimeout(workflowModelNoticeTimer.current);
      workflowModelNoticeTimer.current = setTimeout(() => setWorkflowModelNotice(null), 5000);
    }
    // Picked a usable model: drop any stale notice now (fades out in ~220ms) instead of letting it sit out its timer.
    setFreeTrialModelNotice(null);
    if (freeTrialModelNoticeTimer.current) clearTimeout(freeTrialModelNoticeTimer.current);
    setModel(newModel);
    if (id && !isDraft) dispatch(updateSessionModel({ sessionId: id, model: newModel }));
  }, [id, isDraft, dispatch, workflowEditId, model, resolveModelLabel, connectionMode, freeTrialRemaining]);

  useEffect(() => () => {
    if (workflowModelNoticeTimer.current) clearTimeout(workflowModelNoticeTimer.current);
    if (freeTrialModelNoticeTimer.current) clearTimeout(freeTrialModelNoticeTimer.current);
  }, []);

  const handleThinkingLevelChange = useCallback((level: 'off' | 'low' | 'medium' | 'high' | 'auto') => {
    if (!id) return;
    dispatch(updateSessionThinkingLevel({ sessionId: id, level }));
    if (!isDraft) dispatch(updateThinkingLevel({ sessionId: id, level }));
  }, [id, isDraft, dispatch]);

  const handleApprove = (requestId: string, updatedInput?: Record<string, any>, trustPattern?: boolean, alwaysAllow?: boolean) => {
    dispatch(handleApproval({ requestId, behavior: 'allow', updatedInput, trustPattern, setAlwaysAllow: alwaysAllow }));
  };

  const handleDeny = (requestId: string, message?: string) => {
    dispatch(handleApproval({ requestId, behavior: 'deny', message }));
  };

  const handleStop = useCallback(() => {
    if (!id) return;
    // A watched live workflow run mirrors the workflow card's Stop: fully stop the run, not just pause the agent. Test Agent + plain chats stop the session.
    if (linkedSidecar?.kind === 'watching' && linkedSidecar.runId) {
      dispatch(controlWorkflowRun({ runId: linkedSidecar.runId, action: 'stop' }));
      return;
    }
    dispatch(stopAgent({ sessionId: id }));
  }, [id, dispatch, linkedSidecar]);

  // Finished Test Agent card: drop the tether + remove this card, and either commit the workflow draft (Save, same as the edit card's "save now") or leave the draft untouched so the user keeps editing.
  const onTestContinueEditing = useCallback(() => {
    if (linkedWorkflowId) dispatch(setCardSidecar({ workflowId: linkedWorkflowId, sessionId: null, kind: null }));
    if (id) dispatch(removeCard(id));
  }, [linkedWorkflowId, id, dispatch]);

  const onTestSaveWorkflow = useCallback(async () => {
    if (linkedWorkflowId) {
      try {
        await dispatch(commitDraft(linkedWorkflowId)).unwrap();
      } catch {
        return;
      }
      dispatch(updateWorkflowCard({ workflowId: linkedWorkflowId, patch: { view: 'saved' } }));
      dispatch(setCardSidecar({ workflowId: linkedWorkflowId, sessionId: null, kind: null }));
    }
    if (id) dispatch(removeCard(id));
  }, [linkedWorkflowId, id, dispatch]);

  const handleResume = useCallback(() => {
    if (!id) return;
    setShowResumeBubble(false);
    dispatch(sendMessageThunk({
      sessionId: id,
      prompt: "Continue your previous response from exactly where it was cut off. Do not repeat anything you already wrote; pick up mid-sentence if you need to and keep going.",
      mode,
      model,
      hidden: true,
    }));
  }, [id, mode, model, dispatch]);

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const handleSaveEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!id) return;
      dispatch(editMessage({ sessionId: id, messageId, content: newContent }));
      setEditingMessageId(null);
    },
    [id, dispatch]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const activeBranchMessages = useMemo(() => {
    if (!session) return [];
    const branchId = session.active_branch_id || 'main';
    const branch = session.branches?.[branchId];

    if (!branch || !branch.fork_point_message_id) {
      return session.messages.filter((m) => m.branch_id === 'main' || m.branch_id === branchId);
    }

    const segments: Array<{ branchId: string; upToMessageId?: string }> = [];
    let cur = branch;
    let curId = branchId;
    while (cur && cur.fork_point_message_id) {
      segments.unshift({ branchId: curId, upToMessageId: cur.fork_point_message_id });
      curId = cur.parent_branch_id || 'main';
      cur = session.branches?.[curId];
    }
    segments.unshift({ branchId: curId });

    const result: typeof session.messages = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const nextForkMsgId = seg.upToMessageId;
      if (nextForkMsgId) {
        const forkIdx = session.messages.findIndex((m) => m.id === nextForkMsgId);
        const pre = session.messages
          .slice(0, forkIdx)
          .filter((m) => m.branch_id === seg.branchId);
        result.push(...pre);
      } else if (i < segments.length - 1) {
        const nextFork = segments[i + 1].upToMessageId;
        const forkIdx = nextFork
          ? session.messages.findIndex((m) => m.id === nextFork)
          : session.messages.length;
        result.push(
          ...session.messages.slice(0, forkIdx).filter((m) => m.branch_id === seg.branchId)
        );
      } else {
        result.push(...session.messages.filter((m) => m.branch_id === seg.branchId));
      }
    }
    const leafMsgs = session.messages.filter((m) => m.branch_id === branchId);
    if (!result.some((m) => m.branch_id === branchId)) {
      result.push(...leafMsgs);
    }
    return result;
  }, [session?.messages, session?.active_branch_id, session?.branches]);

  const handleRegenerate = useCallback(
    (assistantMsg: AgentMessage) => {
      if (!id) return;
      const idx = activeBranchMessages.findIndex((m) => m.id === assistantMsg.id);
      for (let i = idx - 1; i >= 0; i--) {
        if (activeBranchMessages[i].role === 'user') {
          const userMsg = activeBranchMessages[i];
          const content = typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content);
          dispatch(editMessage({ sessionId: id, messageId: userMsg.id, content }));
          break;
        }
      }
    },
    [id, activeBranchMessages, dispatch]
  );

  const handleBranchChat = useCallback(async (upToMessageId: string) => {
    if (!id) return;
    const dashId = session?.dashboard_id;
    const action = await dispatch(duplicateSession({ sessionId: id, dashboardId: dashId, upToMessageId }));
    if (duplicateSession.fulfilled.match(action)) {
      if (onBranch) {
        onBranch(action.payload.id);
      } else {
        dispatch(setActiveSession(action.payload.id));
      }
    }
  }, [id, dispatch, onBranch, session?.dashboard_id]);

  const contextEstimate = useMemo(() => {
    // Prefer the live API-reported input token count once we have one (session.tokens.input includes the full request: messages + system + tool defs + cached prefix). That number is authoritative because Anthropic counts it against the context window. Before the first turn completes, fall back to a char/4 estimate of visible message content as a rough pre-send hint.
    let limit = 0;
    for (const ms of Object.values(modelsByProvider)) {
      const hit = ms.find((m) => m.value === model);
      if (hit?.context_window) { limit = hit.context_window; break; }
    }
    if (!limit) limit = (session?.context_window) || CONTEXT_WINDOWS[model] || 200_000;
    const liveInput = session?.tokens?.input ?? 0;
    if (liveInput > 0) {
      return { used: liveInput, limit };
    }
    let totalChars = 0;
    if (session?.system_prompt) totalChars += session.system_prompt.length;
    for (const msg of activeBranchMessages) {
      totalChars += stringifyContent(msg.content).length;
    }
    const used = Math.round(totalChars / 4);
    return { used, limit };
    // Streaming content's contribution to the context estimate is no longer included here: we'd have to subscribe to the streaming text and re-run this sum on every painted character, defeating the whole point of isolating AgentChat from delta updates. The header gauge will catch up when stream_end commits the message.
  }, [activeBranchMessages, session?.system_prompt, session?.tokens?.input, session?.context_window, streamingMessageId, model, modelsByProvider]);

  const sessionRunning = session?.status === 'running' || session?.status === 'waiting_approval';

  const renderItems: RenderItem[] = useMemo(() => {
    const items: RenderItem[] = [];
    let i = 0;
    while (i < activeBranchMessages.length) {
      const msg = activeBranchMessages[i];
      if (msg.role === 'tool_call' || msg.role === 'tool_result') {
        const group: typeof activeBranchMessages = [];
        while (
          i < activeBranchMessages.length &&
          (activeBranchMessages[i].role === 'tool_call' ||
            activeBranchMessages[i].role === 'tool_result')
        ) {
          group.push(activeBranchMessages[i]);
          i++;
        }

        const calls = group.filter((m) => m.role === 'tool_call');
        const results = group.filter((m) => m.role === 'tool_result');
        const pairs: ToolPair[] = calls.map((call, idx) => ({
          type: 'tool_pair' as const,
          id: `pair-${call.id}`,
          call,
          result: results[idx] || null,
        }));

        const mcpServers = new Set(
          calls.map((m) => {
            const tool = typeof m.content === 'object' ? m.content.tool || '' : '';
            const match = tool.match(/^mcp__([^_]+(?:-[^_]+)*)__/);
            return match ? match[1] : '';
          }).filter(Boolean)
        );
        // Only wrap MCP calls in a group when there's more than one; a lone call would just double up the group header on top of its own (e.g. "Browser Navigation 1/1" over "Opened a browser"), so render it bare instead.
        const allSameMcp = mcpServers.size === 1 && pairs.length > 1;

        if (allSameMcp) {
          const mcpServer = [...mcpServers][0];
          const toolNames = new Set(
            calls.map((m) => (typeof m.content === 'object' ? m.content.tool : ''))
          );
          const label =
            toolNames.size === 1 ? calls[0].content?.tool || 'Tool calls' : `${calls.length} tool calls`;
          items.push({
            type: 'tool_group',
            id: `group-${group[0].id}`,
            pairs,
            label,
            callCount: calls.length,
            mcpServer,
          } satisfies ToolGroup);
        } else if (pairs.length <= 2) {
          items.push(...pairs);
        } else if (pairs.length > 0) {
          const toolNames = new Set(
            calls.map((m) => (typeof m.content === 'object' ? m.content.tool : ''))
          );
          const label =
            toolNames.size === 1 ? calls[0].content?.tool || 'Tool calls' : `${calls.length} tool calls`;
          items.push({
            type: 'tool_group',
            id: `group-${group[0].id}`,
            pairs,
            label,
            callCount: calls.length,
          } satisfies ToolGroup);
        }
      } else {
        if (!msg.hidden) {
          items.push(msg);
        }
        i++;
      }
    }
    return items;
  }, [activeBranchMessages]);

  React.useLayoutEffect(() => {
    const total = renderItems.length;
    renderItemsLengthRef.current = total;
    renderItemsRef.current = renderItems;
    const seed = initialSeedItems(viewportHeight);
    let start = windowStartRef.current;
    let end = windowEndRef.current;
    if (isAtBottomRef.current || end === 0) {
      // Following the live tail: keep the newest item mounted and unload the oldest beyond a bounded recent slice so memory stays flat as the transcript grows. The pixel solver refines this seed on the next scroll.
      end = total;
      start = Math.max(0, end - seed);
    } else {
      // Scrolled up: just keep the existing window valid against the new length.
      end = Math.min(end, total);
      start = Math.min(start, Math.max(0, end - 1));
    }
    if (start !== windowStartRef.current) { windowStartRef.current = start; setWindowStart(start); }
    if (end !== windowEndRef.current) { windowEndRef.current = end; setWindowEnd(end); }
  }, [id, renderItems, viewportHeight]);

  const total = renderItems.length;
  // Small chats render whole (no windowing): forces the full slice so both spacer loops sum to 0, which removes the recompute-driven scroll jump entirely.
  const windowingActive = total >= WINDOW_MIN_ITEMS;
  const safeWindowEnd = !windowingActive ? total : (windowEnd > 0 ? Math.min(windowEnd, total) : total);
  const safeWindowStart = !windowingActive ? 0 : Math.min(Math.max(0, windowStart), Math.max(0, safeWindowEnd - 1));
  const visibleStartIndex = safeWindowStart;
  const visibleRenderItems = useMemo(
    () => renderItems.slice(safeWindowStart, safeWindowEnd),
    [renderItems, safeWindowStart, safeWindowEnd]
  );
  const renderedVisibleItems = useMemo(
    () => visibleRenderItems.filter((item) => !streamingMessageId || item.id !== streamingMessageId),
    [streamingMessageId, visibleRenderItems]
  );
  // Keep the ref the height estimator reads in sync with the live viewport width.
  viewportWidthRef.current = viewportWidth;

  // Measure mounted item heights so the spacers that stand in for unmounted items keep the scrollbar geometry stable (no jump when unloading above).
  React.useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    let changed = false;
    el.querySelectorAll<HTMLElement>('[data-window-item-id]').forEach((node) => {
      const itemId = node.dataset.windowItemId;
      if (!itemId) return;
      const h = node.offsetHeight;
      if (h <= 0) return;
      const prev = itemHeightsRef.current.get(itemId);
      if (prev === undefined || Math.abs(prev - h) > 1) {
        itemHeightsRef.current.set(itemId, h);
        changed = true;
      }
    });
    // Guarded so this converges: once heights stop moving, no more version bumps.
    if (changed) setHeightVersion((v) => v + 1);
  });

  // Spacers reserve the cumulative height of the unmounted items above/below the window. heightVersion gates recompute off the ref-held measurements; we index the render-scope renderItems directly so id->height stays correct on the frame the transcript changes.
  const topSpacerHeight = useMemo(() => {
    let h = 0;
    for (let i = 0; i < safeWindowStart; i++) h += reservedHeightForItem(renderItems[i]);
    return h;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderItems, safeWindowStart, heightVersion, reservedHeightForItem]);
  const bottomSpacerHeight = useMemo(() => {
    let h = 0;
    for (let i = safeWindowEnd; i < total; i++) h += reservedHeightForItem(renderItems[i]);
    return h;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderItems, safeWindowEnd, total, heightVersion, reservedHeightForItem]);

  React.useLayoutEffect(() => {
    if (pendingInitialBottomScrollRef.current) {
      const el = scrollContainerRef.current;
      if (!el || visibleRenderItems.length === 0) return;
      let frame = 0;
      const FRAMES = 8;
      const pin = () => {
        const c = scrollContainerRef.current;
        if (!c) return;
        lastVisibleItemRef.current?.scrollIntoView({ block: 'end' });
        c.scrollTop = Math.max(0, Math.min(c.scrollTop, c.scrollHeight - c.clientHeight));
        lastScrollHeightRef.current = c.scrollHeight;
        isAtBottomRef.current = true;
        setShowScrollButton(false);
        if (++frame < FRAMES) {
          initialPinRafRef.current = requestAnimationFrame(pin);
        } else {
          initialPinRafRef.current = null;
          initialBottomScrollSettledRef.current = true;
          // The open slice is sized by item COUNT; now that we're settled and measured, trim it down to the pixel-based band so tall messages high in the slice unload instead of sitting fully rendered off-screen.
          scheduleWindowRecompute();
          // Re-evaluate visibility now the open jump has settled, so an oversized newest message isn't left stuck as a placeholder.
          c.dispatchEvent(new CustomEvent(RECHECK_VISIBILITY_EVENT));
        }
      };
      if (initialPinRafRef.current != null) {
        cancelAnimationFrame(initialPinRafRef.current);
        initialPinRafRef.current = null;
      }
      pendingInitialBottomScrollRef.current = false;
      pin();
    }
  }, [id, session?.active_branch_id, renderItems.length, renderedVisibleItems.length, visibleStartIndex]);

  const lastAssistantIdsInTurn = useMemo(() => {
    const ids = new Set<string>();
    let lastAssistantId: string | null = null;
    for (const item of renderItems) {
      if (!isToolGroup(item) && !isToolPair(item)) {
        const msg = item as AgentMessage;
        if (msg.role === 'assistant') {
          lastAssistantId = msg.id;
        } else if (msg.role === 'user') {
          if (lastAssistantId) ids.add(lastAssistantId);
          lastAssistantId = null;
        }
      }
    }
    if (lastAssistantId) ids.add(lastAssistantId);
    return ids;
  }, [renderItems]);

  const groupMetaRequestedRef = useRef<Set<string>>(new Set());
  const groupMetaRefinedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!id || isDraft) return;
    const toolGroups = renderItems.filter(isToolGroup) as ToolGroup[];
    const meta = session?.tool_group_meta ?? {};

    for (const group of toolGroups) {
      const allDone = group.pairs.every((p) => p.result !== null);

      if (!groupMetaRequestedRef.current.has(group.id) && !meta[group.id]) {
        groupMetaRequestedRef.current.add(group.id);
        const toolCalls = group.pairs.map((p) => {
          const c = p.call.content;
          const tool = typeof c === 'object' ? c.tool || '' : '';
          const input = typeof c === 'object' ? c.input : '';
          const mcp = parseMcpToolName(tool);
          const friendly = mcp.isMcp ? getMcpInputSummary(input, mcp.action, mcp.serverSlug) : '';
          const summary = friendly || (typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120));
          return { tool, input_summary: summary };
        });
        dispatch(generateGroupMeta({ sessionId: id, groupId: group.id, toolCalls }));
      }

      if (allDone && meta[group.id] && !meta[group.id].is_refined && !groupMetaRefinedRef.current.has(group.id)) {
        groupMetaRefinedRef.current.add(group.id);
        const toolCalls = group.pairs.map((p) => {
          const c = p.call.content;
          const tool = typeof c === 'object' ? c.tool || '' : '';
          const input = typeof c === 'object' ? c.input : '';
          const mcp = parseMcpToolName(tool);
          const friendly = mcp.isMcp ? getMcpInputSummary(input, mcp.action, mcp.serverSlug) : '';
          const summary = friendly || (typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120));
          return { tool, input_summary: summary };
        });
        const resultsSummary = group.pairs
          .filter((p) => p.result)
          .map((p) => {
            const rc = p.result!.content;
            const text = typeof rc === 'string' ? rc : typeof rc === 'object' && rc?.text ? rc.text : JSON.stringify(rc);
            return text.slice(0, 150);
          });
        dispatch(generateGroupMeta({ sessionId: id, groupId: group.id, toolCalls, resultsSummary, isRefinement: true }));
      }
    }
  }, [renderItems, id, isDraft, session?.tool_group_meta, dispatch]);

  const getSiblingBranches = useCallback(
    (messageId: string): string[] => {
      if (!session?.branches) return [];

      const directForks = Object.values(session.branches)
        .filter((b) => b.fork_point_message_id === messageId)
        .map((b) => b.id);
      if (directForks.length > 0) {
        const originalMsg = session.messages.find((m) => m.id === messageId);
        const parentBranchId = originalMsg?.branch_id || 'main';
        return [parentBranchId, ...directForks];
      }

      const msg = session.messages.find((m) => m.id === messageId);
      if (!msg || msg.role !== 'user') return [];
      const msgBranch = session.branches[msg.branch_id];
      if (!msgBranch?.fork_point_message_id) return [];
      const branchUserMsgs = session.messages.filter(
        (m) => m.branch_id === msg.branch_id && m.role === 'user'
      );
      if (branchUserMsgs.length === 0 || branchUserMsgs[0].id !== messageId) return [];

      const forkPointId = msgBranch.fork_point_message_id;
      const siblingBranches = Object.values(session.branches)
        .filter((b) => b.fork_point_message_id === forkPointId)
        .map((b) => b.id);
      const parentBranchId = msgBranch.parent_branch_id || 'main';
      return [parentBranchId, ...siblingBranches];
    },
    [session?.branches, session?.messages]
  );

  if (!session) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
        <Typography sx={{ color: c.text.tertiary, fontSize: '1rem' }}>
          Session not found
        </Typography>
      </Box>
    );
  }

  const branchNavLocked = agentBusy || hasStreaming;
  const statusStyle = STATUS_STYLES[session.status] || { color: c.text.tertiary, bg: c.bg.secondary };

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      <ContextDrawer />
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {!embedded && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              px: 2,
              py: 1.5,
              // No seam: the header is just a band of typography inside the chat panel; transparent bg + air carry it, no hairline. (An earlier bg.surface here read lighter than the body and pulled focus.)
              bgcolor: 'transparent',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typewriter
                  value={displayChatTitle(session)}
                  enabled={!!session.name && !isLegacyAutoName(session.name)}
                >
                  {(t) => <Typography noWrap sx={{ color: c.text.primary, fontWeight: 600 }}>{t}</Typography>}
                </Typewriter>
                {!isDraft && statusStyle && session.status !== 'completed' && session.status !== 'stopped' && (
                  // Status speaks only when it needs the user; finished work sits quiet.
                  <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: c.text.tertiary, whiteSpace: 'nowrap' }}>
                      {friendlyStatusLabel(session.status)}
                    </Typography>
                  </Box>
                )}
              </Box>
              {(!isDraft || session.is_welcome_draft) && (
                // Welcome draft shows just the model so the header isn't bare; real runs add branch + cost.
                <Box sx={{ display: 'flex', gap: 1.5, mt: 0.25, alignItems: 'center' }}>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {resolveModelLabel(session.model)}
                  </Typography>
                  {!isDraft && session.branch_name && (
                    <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                      {session.branch_name}
                    </Typography>
                  )}
                  {(() => {
                    if (!(session.cost_usd > 0)) return null;
                    // The SDK reports a per-call $ figure regardless of how the request was routed. For requests that went through a subscription path, that figure is misleading, the user pays flat-rate. Show "subscription" instead in those cases. Show $ only when the call was actually metered (Anthropic API key, OpenAI API key, etc.). Model-id signals (these are short_name values from the BUILTIN_MODELS registry): - `*-api` → pinned Anthropic API key (METERED) - `*-cc` → pinned Claude Pro/Max via 9Router (sub) - plain sonnet/opus/haiku + openswarm-pro mode → Pro proxy (sub) - plain sonnet/opus/haiku + own_key mode → API key (METERED) - gpt-5.4* / gpt-5.3* → ChatGPT Plus/Pro via 9Router (sub) - gemini-*  → Gemini Advanced via 9Router (sub)
                    const m = (session.model || '').toLowerCase();
                    const isApiRoute = m.endsWith('-api');
                    if (isApiRoute) {
                      return (
                        <Typography variant="caption" sx={{ color: c.accent.primary }}>
                          ${session.cost_usd.toFixed(4)}
                        </Typography>
                      );
                    }
                    const isCcRoute = m.endsWith('-cc');
                    const isPlainAnthropic = m === 'sonnet' || m === 'opus' || m === 'haiku';
                    const isProRoute = isPlainAnthropic && connectionMode === 'openswarm-pro';
                    const isOwnKeyAnthropic = isPlainAnthropic && connectionMode !== 'openswarm-pro';
                    const isOpenAISub = m.startsWith('gpt-5') || m.startsWith('gpt-4') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
                    const isGeminiSub = m.startsWith('gemini-');
                    const isSubscriptionRouted = isCcRoute || isProRoute || isOpenAISub || isGeminiSub;
                    if (isSubscriptionRouted) {
                      return (
                        <Typography
                          variant="caption"
                          sx={{ color: c.text.tertiary }}
                          title="Routed through subscription, flat-rate, per-call cost not metered"
                        >
                          subscription
                        </Typography>
                      );
                    }
                    // own-key Anthropic OR anything else → real $ figure.
                    void isOwnKeyAnthropic;
                    return (
                      <Typography variant="caption" sx={{ color: c.accent.primary }}>
                        ${session.cost_usd.toFixed(4)}
                      </Typography>
                    );
                  })()}
                  {(() => {
                    const mcpCount = session.active_mcps?.length ?? 0;
                    if (mcpCount === 0) return null;
                    return (
                      <Typography
                        variant="caption"
                        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontVariantNumeric: 'tabular-nums' }}
                        title={`${mcpCount} tool${mcpCount === 1 ? '' : 's'} connected.`}
                      >
                        <Box component="span" sx={{ color: c.text.tertiary }}>
                          {mcpCount} tool{mcpCount === 1 ? '' : 's'}
                        </Box>
                      </Typography>
                    );
                  })()}
                </Box>
              )}
            </Box>
            {!isDraft && id && (
              <Tooltip title="Reset history">
                <IconButton
                  size="small"
                  onClick={async () => {
                    const sid = id;
                    // Reset local UI state first; clearSessionMessages only touches Redux session.messages, so showResumeBubble/awaitingResponse/the queue otherwise survive and a "thinking" or "Resume agent response" bubble lingers on a now-empty chat.
                    setShowResumeBubble(false);
                    setAwaitingResponse(false);
                    messageQueueRef.current = [];
                    setQueueLength(0);
                    setQueueExpanded(false);
                    setEditingQueueIdx(null);
                    setEditingQueueText('');
                    try {
                      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
                      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                      if (tok) headers['Authorization'] = `Bearer ${tok}`;
                      await fetch(`${API_BASE}/agents/sessions/${sid}/clear`, { method: 'POST', headers });
                    } catch { /* surfaced via context_status */ }
                    dispatch(clearSessionMessages(sid));
                  }}
                  sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
                >
                  <RestartAltIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {onClose && (
              <IconButton onClick={onClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        )}

        <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Box
            ref={scrollContainerRef}
            onScroll={handleScroll}
            sx={{
              height: '100%',
              overflow: 'auto',
              scrollbarGutter: 'stable',
              // Top-aligned natural flow: messages start at the top and grow down (standard chat). The earlier flex-column + mt:auto bottom-anchor clustered short chats at the bottom under a big void, reading broken.
              px: 2,
              py: 1,
              // Smoothness bundle (perf-only, no behavior change): 1. overflow-anchor: auto, Chromium's native scroll anchoring keeps the viewport pinned to the user's visible content as siblings above/below resize. Eliminates the "transcript snaps back" feel during streaming and parallel tool fan-outs. Runs on the compositor thread, free. 2. contain: layout, tells the browser layout shifts inside this scroll container don't affect siblings outside it. Prevents reflow from cascading up to the dashboard layout when bubbles grow. 3. overscroll-behavior: contain, keeps over-scroll gestures from leaking up to the dashboard pan/zoom when the user hits the chat top/bottom.
              overflowAnchor: 'auto',
              contain: 'layout',
              overscrollBehavior: 'contain',
              // Hidden until the user is in the chat: the thumb is transparent at rest and fades in on hover, so a resizing thumb never draws the eye.
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
              '&::-webkit-scrollbar-thumb': {
                background: 'transparent',
                borderRadius: 3,
                minHeight: 48,
                transition: 'background 0.2s',
              },
              '&:hover::-webkit-scrollbar-thumb': { background: c.border.medium },
              '&:hover::-webkit-scrollbar-thumb:hover': { background: c.border.strong },
              scrollbarWidth: 'thin',
              scrollbarColor: 'transparent transparent',
              '&:hover': { scrollbarColor: `${c.border.medium} transparent` },
            }}
          >
            <Box>
            {session.context_overflow && (() => {
              const reason = session.context_overflow.reason;
              const isAuth = reason === 'openswarm_pro_auth_expired' || reason === 'anthropic_auth_invalid' || reason === 'auth_error';
              const isOutOfTokens = reason === 'out_of_tokens';
              const title = isOutOfTokens ? 'Out of tokens' : isAuth ? 'Sign-in required' : 'Context full';
              const primaryLabel = isOutOfTokens ? 'Got it' : isAuth ? 'Open Settings' : 'Start a fresh chat';
              // In the workflow build chat, switching models here also sets the workflow's scheduled run model, so spell that consequence out.
              const message = isOutOfTokens && workflowEditId
                ? `${session.context_overflow.message} Whichever model you switch to here becomes the model this workflow runs on.`
                : session.context_overflow.message;
              const onPrimary = () => {
                if (isOutOfTokens) {
                  if (id) dispatch(clearContextOverflow({ sessionId: id }));
                } else if (isAuth) {
                  dispatch(openSettingsModal('models'));
                } else {
                  const did = session?.dashboard_id;
                  window.location.hash = did ? `#/dashboard/${did}` : '#/';
                }
              };
              return (
                <Box sx={{
                  mt: 1,
                  mb: 1.5,
                  p: 1.5,
                  borderRadius: 1.5,
                  border: `1px solid ${c.border.strong}`,
                  bgcolor: c.bg.secondary,
                }}>
                  <Typography variant="body2" sx={{ color: c.text.primary, fontWeight: 500, mb: 0.5 }}>
                    {title}
                  </Typography>
                  <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block', mb: 1.25 }}>
                    {message}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Typography
                      component="button"
                      variant="caption"
                      onClick={onPrimary}
                      sx={{
                        cursor: 'pointer',
                        border: `1px solid ${c.border.medium}`,
                        borderRadius: 1,
                        px: 1.25,
                        py: 0.5,
                        bgcolor: 'transparent',
                        color: c.text.primary,
                        '&:hover': { bgcolor: c.bg.elevated },
                      }}
                    >
                      {primaryLabel}
                    </Typography>
                  </Box>
                </Box>
              );
            })()}
            {/* Stand-in for items unmounted ABOVE the window. Its measured
                height keeps the scrollbar geometry and scroll position stable
                while overflow-anchor pins the visible content. */}
            {topSpacerHeight > 0 && (
              <Box aria-hidden data-window-spacer="top" sx={{ height: topSpacerHeight, flexShrink: 0, overflowAnchor: 'none' }} />
            )}
            {renderedVisibleItems.map((item, itemIdx) => {
              const isLastVisibleItem = itemIdx === renderedVisibleItems.length - 1;
              const isCompactionAnchor = !!session.compacted_through_msg_id && item.id === session.compacted_through_msg_id;
              const compactionChip = isCompactionAnchor ? (
                <CompactionMarker
                  key={`compaction-${item.id}`}
                  collapsedCount={
                    Math.max(0, renderItems.findIndex((it) => it.id === session.compacted_through_msg_id) + 1)
                  }
                />
              ) : null;

              if (isToolGroup(item)) {
                const groupMeta = session.tool_group_meta?.[item.id];
                return (
                  <Box key={item.id} data-window-item-id={item.id} ref={isLastVisibleItem ? lastVisibleItemRef : undefined}>
                    <ToolGroupBubble group={item} isSessionRunning={sessionRunning} meta={groupMeta} sessionId={session.id} />
                    {compactionChip}
                  </Box>
                );
              }
              if (isToolPair(item)) {
                const isPending = item.result === null && sessionRunning;
                return (
                  <Box key={item.id} data-window-item-id={item.id} ref={isLastVisibleItem ? lastVisibleItemRef : undefined}>
                    <ToolCallBubble call={item.call} result={item.result} isPending={isPending} sessionId={session.id} suppressReveal={item.call.id === justStreamedId} />
                    {compactionChip}
                  </Box>
                );
              }
              const msg = item;
              const isEditing = editingMessageId === msg.id;
              const siblings = getSiblingBranches(msg.id);
              const hasBranches = siblings.length > 0;
              const currentBranchIdx = hasBranches
                ? siblings.indexOf(session.active_branch_id || 'main')
                : 0;
              const rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

              return (
                <Box key={msg.id} data-window-item-id={msg.id} ref={isLastVisibleItem ? lastVisibleItemRef : undefined}>
                  <Box
                  sx={{
                    '&:hover .msg-actions': { opacity: 1 },
                    // Cheap virtualization: tells the browser to skip paint + layout for bubbles outside the scroll viewport. `contain-intrinsic-size: auto N` reserves a placeholder height so the scrollbar doesn't jump, and `auto` lets the browser remember the actual height after first render. Works alongside the container's overflow-anchor. Chrome 85+ (Electron covers this).
                    contentVisibility: 'auto',
                    containIntrinsicSize: 'auto 120px',
                  }}
                >
                  <MessageBubble
                    message={msg}
                    editing={isEditing}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                    viewportHeight={viewportHeight}
                    viewportWidth={viewportWidth}
                    scrollRoot={scrollRoot}
                  />
                  {!isEditing && (msg.role === 'user' || (msg.role === 'assistant' && lastAssistantIdsInTurn.has(msg.id))) && (
                    <MessageActionBar
                      role={msg.role as 'user' | 'assistant'}
                      sessionId={session.id}
                      messageId={msg.id}
                      onCopy={() => navigator.clipboard.writeText(rawText)}
                      onEdit={msg.role === 'user' ? () => setEditingMessageId(msg.id) : undefined}
                      onRegenerate={msg.role === 'assistant' ? () => handleRegenerate(msg) : undefined}
                      onBranch={msg.role === 'assistant' ? () => handleBranchChat(msg.id) : undefined}
                      branchNav={
                        hasBranches
                          ? {
                              currentIndex: Math.max(0, currentBranchIdx),
                              totalBranches: siblings.length,
                              disabled: branchNavLocked,
                              onPrevious: () => {
                                if (branchNavLocked) return;
                                const prevBranch = siblings[Math.max(0, currentBranchIdx - 1)];
                                if (prevBranch && id) dispatch(switchBranch({ sessionId: id, branchId: prevBranch }));
                              },
                              onNext: () => {
                                if (branchNavLocked) return;
                                const nextBranch = siblings[Math.min(siblings.length - 1, currentBranchIdx + 1)];
                                if (nextBranch && id) dispatch(switchBranch({ sessionId: id, branchId: nextBranch }));
                              },
                            }
                          : undefined
                      }
                    />
                  )}
                  {compactionChip}
                </Box>
                </Box>
              );
            })}
            {/* Stand-in for items unmounted BELOW the window (newer items not yet
                scrolled into view). Zero while following the live tail. */}
            {bottomSpacerHeight > 0 && (
              <Box aria-hidden data-window-spacer="bottom" sx={{ height: bottomSpacerHeight, flexShrink: 0, overflowAnchor: 'none' }} />
            )}
            {/* overflow-anchor: none on the two elements that grow every frame
                (live stream + thinking dots) keeps Chromium's scroll anchoring
                from fighting our jam-to-bottom for the scroll position. The
                committed messages above keep the default anchor, so resizing a
                tool row while the user has scrolled up still holds their view. */}
            {id && (
              <Box sx={{ overflowAnchor: 'none' }}>
                <StreamingBubble
                  sessionId={id}
                  activeBranchId={session.active_branch_id || 'main'}
                  turnLabel={session.turn_label?.label}
                  onStreamGrew={stickToBottomIfNeeded}
                />
              </Box>
            )}
            {/* Connect offer sits BELOW the latest reply (where the eye is), not at the top of the
                transcript where the auto-scroll-to-bottom buries it. Suggest-only; activation is the
                user's click through the gated MCPActivate endpoint. */}
            {(session.mcp_suggestions && session.mcp_suggestions.length > 0) && (
              <Box sx={{ mt: 1, mb: 1, px: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5, overflowAnchor: 'none' }}>
                {session.mcp_suggestions.map((s) => (
                  <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ color: c.text.secondary, flex: 1, minWidth: 0 }}>
                      Connect{' '}
                      <Box component="span" sx={{ color: c.text.primary, fontWeight: 500 }}>{s.title}</Box>
                      {' '}so the agent can do this
                    </Typography>
                    <Typography
                      component="button"
                      variant="caption"
                      disabled={activatingMcp === s.id}
                      onClick={async () => {
                        if (activatingMcp) return;
                        setActivateError(null);
                        setActivatingMcp(s.id);
                        try {
                          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                          const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
                          if (tok) headers['Authorization'] = `Bearer ${tok}`;
                          const r = await fetch(`${API_BASE}/mcp-meta/activate`, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({
                              server_name: s.id.toLowerCase().replace(/\s+/g, '-'),
                              reason: s.reason || 'preflight suggestion',
                              parent_session_id: session.id,
                            }),
                          });
                          const body = await r.json().catch(() => ({} as any));
                          if (!r.ok) {
                            setActivateError(`Activation failed (${r.status})`);
                          } else if (body?.status === 'unknown_server') {
                            // Not yet connected; jump to Actions so the user can finish OAuth.
                            dispatch(openSettingsModal('tools'));
                          } else if (id) {
                            dispatch(clearMcpSuggestions({ sessionId: id }));
                          }
                        } catch (e: any) {
                          setActivateError(e?.message || 'Activation failed');
                        } finally {
                          setActivatingMcp(null);
                        }
                      }}
                      sx={{
                        border: 'none',
                        background: 'none',
                        p: 0,
                        color: c.accent.primary,
                        cursor: activatingMcp === s.id ? 'wait' : 'pointer',
                        opacity: activatingMcp === s.id ? 0.5 : 1,
                        '&:hover': { textDecoration: activatingMcp ? 'none' : 'underline' },
                        flexShrink: 0,
                      }}
                    >
                      {activatingMcp === s.id ? 'Connecting…' : 'Connect'}
                    </Typography>
                  </Box>
                ))}
                {activateError && (
                  <Typography variant="caption" sx={{ display: 'block', color: c.status.error }}>
                    {activateError}
                  </Typography>
                )}
                <Box
                  role="button"
                  aria-label="Dismiss"
                  onClick={() => id && dispatch(clearMcpSuggestions({ sessionId: id }))}
                  sx={{ alignSelf: 'flex-start', color: c.text.muted, cursor: 'pointer', fontSize: '0.72rem', '&:hover': { color: c.text.secondary } }}
                >
                  Dismiss
                </Box>
              </Box>
            )}
            {/* First-run welcome chips: sit UNDER the streamed greeting, appear once it finishes,
                vanish the moment the user answers. The greeting itself is a real assistant bubble. */}
            {session.is_welcome_draft && isDraft && welcomeGreetingDone && !session.messages.some((m) => m.role === 'user') && (
              <WelcomeQuickReplies
                c={c}
                onPick={(p) => handleSend(p)}
                onPickBuilder={(p) => chatInputRef.current?.setContent(p)}
              />
            )}
            {(preSendActivityLabel || awaitingResponse || (session.status === 'running' && !streamingMessageId)) && (
              <Box sx={{ overflowAnchor: 'none' }}>
                <ThinkingBubble
                  label={preSendActivityLabel || session.turn_label?.label}
                  seedKey={`${session.id}:${session.messages?.length ?? 0}`}
                />
              </Box>
            )}
            {showResumeBubble && session.status === 'stopped' && !isWorkflowRunSidecar && !readOnly && (
              <Box sx={{ display: 'flex', justifyContent: 'flex-start', my: 0.75 }}>
                <Box
                  onClick={handleResume}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1.5,
                    py: 0.75,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    bgcolor: `${c.accent.primary}10`,
                    border: `1px solid ${c.accent.primary}30`,
                    transition: 'all 0.15s',
                    '&:hover': {
                      bgcolor: `${c.accent.primary}1a`,
                      border: `1px solid ${c.accent.primary}50`,
                    },
                  }}
                >
                  <PlayArrowIcon sx={{ fontSize: 14, color: c.accent.primary }} />
                  <Typography sx={{ fontSize: '0.78rem', fontWeight: 500, color: c.accent.primary }}>
                    Resume Agent Response
                  </Typography>
                </Box>
              </Box>
            )}
            </Box>
          </Box>
          {showScrollButton && (
            <Tooltip title="Scroll to bottom">
              <IconButton
                onClick={scrollToBottom}
                sx={{
                  position: 'absolute',
                  bottom: 12,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  color: c.accent.primary,
                  width: 36,
                  height: 36,
                  '&:hover': { bgcolor: c.bg.secondary },
                  boxShadow: c.shadow.md,
                  zIndex: 1,
                }}
              >
                <KeyboardArrowDownIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>

        {session.pending_approvals.length > 1 ? (
          <BatchApprovalBar requests={session.pending_approvals} onApprove={handleApprove} onDeny={handleDeny} />
        ) : (
          session.pending_approvals.map((req) => (
            <ApprovalBar key={req.id} request={req} onApprove={handleApprove} onDeny={handleDeny} />
          ))
        )}

        <RateLimitPill sessionId={session.id} />

        {isGlowing ? (
          <Box
            onClick={(e) => { e.stopPropagation(); onDismissGlow?.(); }}
            sx={{
              mx: 1.5,
              mb: 1.5,
              py: 1.25,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 2.5,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              color: c.accent.primary,
              border: `1.5px solid ${c.accent.primary}`,
              background: `${c.accent.primary}08`,
              boxShadow: `0 0 12px ${c.accent.primary}25, inset 0 0 12px ${c.accent.primary}08`,
              transition: 'background 0.15s, box-shadow 0.15s',
              '&:hover': {
                background: `${c.accent.primary}14`,
                boxShadow: `0 0 24px ${c.accent.primary}50, inset 0 0 20px ${c.accent.primary}18`,
              },
            }}
          >
            Continue chat
          </Box>
        ) : (
          <ClickAwayListener onClickAway={() => { if (queueExpanded) { setQueueExpanded(false); setEditingQueueIdx(null); } }}>
            <Box>
              {queueLength > 0 && (
                <Box sx={{ ml: 3, mr: 1.5 }}>
                  <Box
                    onClick={() => { setQueueExpanded((v) => !v); setEditingQueueIdx(null); }}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      px: 1.25,
                      py: 0.25,
                      borderRadius: '8px 8px 0 0',
                      bgcolor: c.bg.surface,
                      border: `1px solid ${c.border.subtle}`,
                      borderBottom: 'none',
                      cursor: 'pointer',
                      userSelect: 'none',
                      '&:hover': { bgcolor: c.bg.secondary },
                      transition: 'background 0.12s',
                    }}
                  >
                    {queueExpanded
                      ? <KeyboardArrowDownIcon sx={{ fontSize: 12, color: c.text.tertiary }} />
                      : <KeyboardArrowUpIcon sx={{ fontSize: 12, color: c.text.tertiary }} />
                    }
                    <Typography sx={{ fontSize: '0.68rem', fontWeight: 600, color: c.text.muted, letterSpacing: 0.2 }}>
                      {queueLength} queued
                    </Typography>
                    <Tooltip title="Clear all">
                      <IconButton
                        size="small"
                        onClick={(e) => { e.stopPropagation(); messageQueueRef.current = []; setQueueLength(0); setQueueExpanded(false); setEditingQueueIdx(null); }}
                        sx={{ p: 0.15, color: c.text.tertiary, '&:hover': { color: c.status.error } }}
                      >
                        <CloseIcon sx={{ fontSize: 10 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>

                  {queueExpanded && (
                    <Box
                      sx={{
                        bgcolor: c.bg.surface,
                        border: `1px solid ${c.border.subtle}`,
                        borderBottom: 'none',
                        borderRadius: '0 8px 0 0',
                        maxHeight: 240,
                        overflowY: 'auto',
                        '&::-webkit-scrollbar': { width: 4 },
                        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
                      }}
                    >
                      {messageQueueRef.current.map((msg, idx) => (
                        <Box
                          key={idx}
                          draggable={editingQueueIdx !== idx}
                          onDragStart={(e) => {
                            setDragIdx(idx);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dragIdx !== null && dragIdx !== idx) setDropTargetIdx(idx);
                          }}
                          onDragLeave={() => { if (dropTargetIdx === idx) setDropTargetIdx(null); }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIdx !== null && dragIdx !== idx) {
                              const q = messageQueueRef.current;
                              const [item] = q.splice(dragIdx, 1);
                              q.splice(idx, 0, item);
                              setQueueLength(q.length);
                            }
                            setDragIdx(null);
                            setDropTargetIdx(null);
                          }}
                          onDragEnd={() => { setDragIdx(null); setDropTargetIdx(null); }}
                          sx={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 0.75,
                            px: 1.5,
                            py: 1,
                            borderBottom: idx < queueLength - 1 ? `1px solid ${c.border.subtle}` : 'none',
                            '&:hover': { bgcolor: c.bg.secondary },
                            transition: 'background 0.1s, opacity 0.15s',
                            ...(dragIdx === idx ? { opacity: 0.35 } : {}),
                            ...(dropTargetIdx === idx && dragIdx !== null && dragIdx !== idx
                              ? { borderTop: `2px solid ${c.accent.primary}` }
                              : {}),
                          }}
                        >
                          <Box
                            sx={{
                              cursor: editingQueueIdx === idx ? 'default' : 'grab',
                              display: 'flex',
                              alignItems: 'center',
                              mt: 0.3,
                              color: c.text.ghost,
                              '&:hover': { color: c.text.tertiary },
                              '&:active': { cursor: 'grabbing' },
                            }}
                          >
                            <DragIndicatorIcon sx={{ fontSize: 14 }} />
                          </Box>
                          {editingQueueIdx === idx ? (
                            <Box sx={{ flex: 1, display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
                              <TextField
                                multiline
                                fullWidth
                                size="small"
                                value={editingQueueText}
                                onChange={(e) => setEditingQueueText(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    const trimmed = editingQueueText.trim();
                                    if (trimmed) {
                                      messageQueueRef.current[idx] = { ...messageQueueRef.current[idx], prompt: trimmed };
                                      setQueueLength(messageQueueRef.current.length);
                                    }
                                    setEditingQueueIdx(null);
                                  }
                                  if (e.key === 'Escape') setEditingQueueIdx(null);
                                }}
                                sx={{
                                  '& .MuiOutlinedInput-root': {
                                    fontSize: '0.78rem',
                                    color: c.text.primary,
                                    '& fieldset': { borderColor: c.border.medium },
                                    '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                                  },
                                }}
                              />
                              <IconButton
                                size="small"
                                onClick={() => {
                                  const trimmed = editingQueueText.trim();
                                  if (trimmed) {
                                    messageQueueRef.current[idx] = { ...messageQueueRef.current[idx], prompt: trimmed };
                                    setQueueLength(messageQueueRef.current.length);
                                  }
                                  setEditingQueueIdx(null);
                                }}
                                sx={{ p: 0.25, color: c.accent.primary, mt: 0.25 }}
                              >
                                <CheckIcon sx={{ fontSize: 14 }} />
                              </IconButton>
                            </Box>
                          ) : (
                            <Typography
                              sx={{
                                flex: 1,
                                fontSize: '0.78rem',
                                color: c.text.secondary,
                                lineHeight: 1.5,
                                overflow: 'hidden',
                                display: '-webkit-box',
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical',
                                wordBreak: 'break-word',
                              }}
                            >
                              {msg.prompt}
                            </Typography>
                          )}
                          {editingQueueIdx !== idx && (
                            <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0, mt: 0.15 }}>
                              <Tooltip title="Edit">
                                <IconButton
                                  size="small"
                                  onClick={() => { setEditingQueueIdx(idx); setEditingQueueText(msg.prompt); }}
                                  sx={{ p: 0.25, color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
                                >
                                  <EditOutlinedIcon sx={{ fontSize: 13 }} />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Remove">
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    messageQueueRef.current.splice(idx, 1);
                                    setQueueLength(messageQueueRef.current.length);
                                    if (messageQueueRef.current.length === 0) setQueueExpanded(false);
                                  }}
                                  sx={{ p: 0.25, color: c.text.tertiary, '&:hover': { color: c.status.error } }}
                                >
                                  <DeleteOutlineIcon sx={{ fontSize: 13 }} />
                                </IconButton>
                              </Tooltip>
                            </Box>
                          )}
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              )}
              {(() => {
                // Proactive Haiku-overflow warning. Each connected MCP adds a sizeable tools-schema chunk to every Claude request; Haiku 4.5's window is 5x smaller than Sonnet/Opus, so 5+ simultaneously-enabled MCPs reliably push a one-line message past the limit. We surface this BEFORE the user sends so they don't waste a turn on "Prompt is too long".
                const isHaiku = (model || '').toLowerCase().startsWith('haiku');
                const enabledMcpCount = Object.values(toolItems).filter(
                  (t) => t.enabled && t.mcp_config && Object.keys(t.mcp_config).length > 0,
                ).length;
                if (!isHaiku || enabledMcpCount < 5) return null;
                return (
                  <Box
                    sx={{
                      mx: 2,
                      mb: 1,
                      p: 1.5,
                      borderRadius: `${c.radius.lg}px`,
                      border: `1px solid ${c.status.warning}40`,
                      bgcolor: `${c.status.warning}10`,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 1.2,
                    }}
                  >
                    <Box sx={{ flexShrink: 0, mt: 0.2 }}>
                      <ErrorSlime size={20} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: '0.86rem', fontWeight: 600, color: c.text.primary, mb: 0.4 }}>
                        Haiku may run out of room with {enabledMcpCount} apps connected
                      </Typography>
                      <Typography sx={{ fontSize: '0.78rem', color: c.text.secondary, lineHeight: 1.45 }}>
                        Haiku is the fastest Claude model but holds the least at once.
                        Each connected app adds instructions Claude has to read first.
                        If your message fails with “Prompt is too long,” turn off a few
                        apps (Microsoft 365 is the heaviest) or switch to Sonnet/Opus,
                        both have 5× more room.
                      </Typography>
                    </Box>
                  </Box>
                );
              })()}
              {(() => {
                const list = session.mcp_suggestions ?? [];
                if (list.length) mcpSnapshotRef.current = list;
                const display = mcpSnapshotRef.current;
                return (
                  <Fade in={list.length > 0} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
                    <Box sx={{
                      mx: 2,
                      mb: 1,
                      p: 1.5,
                      borderRadius: 1.5,
                      border: `1px solid ${c.border.medium}`,
                      bgcolor: c.bg.secondary,
                      position: 'relative',
                    }}>
                      <Box
                        role="button"
                        aria-label="Dismiss integration suggestion"
                        onClick={() => {
                          if (!id) return;
                          dispatch(clearMcpSuggestions({ sessionId: id }));
                          dispatch(dismissMcpSuggestion(display.map((s) => s.id)));
                        }}
                        sx={{
                          position: 'absolute',
                          top: 6,
                          right: 8,
                          width: 20,
                          height: 20,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '1rem',
                          lineHeight: 1,
                          color: c.text.muted,
                          cursor: 'pointer',
                          borderRadius: 0.75,
                          '&:hover': { color: c.text.primary, bgcolor: c.bg.elevated },
                        }}
                      >
                        ×
                      </Box>
                      <Typography variant="body2" sx={{ color: c.text.primary, fontWeight: 500, mb: 0.5, pr: 3 }}>
                        Looks like this might need an integration
                      </Typography>
                      <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block', mb: 1 }}>
                        Activating one of these will let the agent answer in a single round-trip.
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                        {display.map((s) => (
                          <Box key={s.id} sx={{ flexBasis: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography variant="caption" sx={{ color: c.text.primary, fontWeight: 500 }}>
                                {s.title}
                              </Typography>
                              {s.reason && (
                                <Typography variant="caption" sx={{ display: 'block', color: c.text.tertiary }}>
                                  {s.reason}
                                </Typography>
                              )}
                            </Box>
                            <Typography
                              component="button"
                              variant="caption"
                              disabled={activatingMcp === s.id}
                              onClick={async () => {
                                if (activatingMcp) return;
                                setActivateError(null);
                                setActivatingMcp(s.id);
                                try {
                                  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                                  const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
                                  if (tok) headers['Authorization'] = `Bearer ${tok}`;
                                  const r = await fetch(`${API_BASE}/mcp-meta/activate`, {
                                    method: 'POST',
                                    headers,
                                    body: JSON.stringify({
                                      server_name: s.id.toLowerCase().replace(/\s+/g, '-'),
                                      reason: s.reason || 'preflight suggestion',
                                      parent_session_id: session.id,
                                    }),
                                  });
                                  const body = await r.json().catch(() => ({} as any));
                                  if (!r.ok) {
                                    setActivateError(`Activation failed (${r.status})`);
                                  } else if (body?.status === 'unknown_server') {
                                    // Not yet connected; jump straight to Actions so the user can finish OAuth. Nothing here can do it on their behalf.
                                    dispatch(openSettingsModal('tools'));
                                  } else if (id) {
                                    // Activation succeeded; clear the banner so the user gets visual confirmation the click did something.
                                    dispatch(clearMcpSuggestions({ sessionId: id }));
                                  }
                                } catch (e: any) {
                                  setActivateError(e?.message || 'Activation failed');
                                } finally {
                                  setActivatingMcp(null);
                                }
                              }}
                              sx={{
                                cursor: activatingMcp === s.id ? 'wait' : 'pointer',
                                border: `1px solid ${c.border.medium}`,
                                borderRadius: 1,
                                px: 1.25,
                                py: 0.5,
                                bgcolor: 'transparent',
                                color: c.text.primary,
                                opacity: activatingMcp === s.id ? 0.5 : 1,
                                '&:hover': { bgcolor: activatingMcp ? 'transparent' : c.bg.elevated },
                                flexShrink: 0,
                              }}
                            >
                              {activatingMcp === s.id ? 'Activating…' : 'Activate'}
                            </Typography>
                          </Box>
                        ))}
                      </Box>
                      {activateError && (
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: c.status.error }}>
                          {activateError}
                        </Typography>
                      )}
                    </Box>
                  </Fade>
                );
              })()}
              {readOnly ? null : isStoppableSidecar ? (
                <ForceStopAgentBar onStop={handleStop} onSaveWorkflow={onTestSaveWorkflow} onContinueEditing={onTestContinueEditing} testState={testState} />
              ) : (
                <Box sx={{ position: 'relative' }}>
                  <WorkflowModelNotice c={c} label={workflowModelNotice} />
                  <FreeTrialModelNotice c={c} notice={freeTrialModelNotice} />
                  <ChatInput
                  ref={chatInputRef}
                  onSend={handleSend}
                  disabled={false}
                  mode={mode}
                  onModeChange={handleModeChange}
                  model={model}
                  onModelChange={handleModelChange}
                  isRunning={agentBusy}
                  onStop={handleStop}
                  queueLength={queueLength}
                  contextEstimate={contextEstimate}
                  sessionId={id}
                  autoFocus={autoFocus}
                  prefillPrompt={prefillPrompt}
                  placeholderOverride={runContext ? 'Ask about this run...' : undefined}
                  runContext={runContext}
                  onClearRunContext={onClearRunContext}
                  thinkingLevel={session?.thinking_level ?? 'auto'}
                  onThinkingLevelChange={handleThinkingLevelChange}
                  onActivityLabelChange={setPreSendActivityLabel}
                  />
                </Box>
              )}
            </Box>
          </ClickAwayListener>
        )}
      </Box>
    </Box>
  );
};

// Brief toast above the build chat's composer confirming a model switch also changes the model the scheduled workflow will run on. Holds the last label in a ref so the exit fade renders content instead of blanking mid-animation.
function WorkflowModelNotice({ c, label }: { c: ReturnType<typeof useClaudeTokens>; label: string | null }) {
  const last = React.useRef<string | null>(null);
  if (label) last.current = label;
  const display = last.current;
  if (!display) return null;
  return (
    <Fade in={!!label} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box sx={{
        position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 8px)',
        display: 'flex', alignItems: 'center', gap: 1,
        bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
        boxShadow: c.shadow.md, borderRadius: '12px',
        px: 1.75, py: 1, zIndex: 6,
      }}>
        <SwapHorizRoundedIcon sx={{ fontSize: 17, color: c.accent.primary, flexShrink: 0 }} />
        <Box sx={{ fontSize: '0.83rem', color: c.text.primary, lineHeight: 1.4 }}>
          This workflow will now be using <b>{display}</b>.
        </Box>
      </Box>
    </Fade>
  );
}

function FreeTrialModelNotice({ c, notice }: { c: ReturnType<typeof useClaudeTokens>; notice: { kind: 'connect' | 'spent'; label: string } | null }) {
  const last = React.useRef<{ kind: 'connect' | 'spent'; label: string } | null>(null);
  if (notice) last.current = notice;
  const display = last.current;
  if (!display) return null;
  return (
    <Fade in={!!notice} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box sx={{
        position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 8px)',
        display: 'flex', alignItems: 'center', gap: 1,
        bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
        boxShadow: c.shadow.md, borderRadius: '12px',
        px: 1.75, py: 1, zIndex: 6,
      }}>
        <InfoOutlinedIcon sx={{ fontSize: 17, color: c.accent.primary, flexShrink: 0 }} />
        <Box sx={{ fontSize: '0.83rem', color: c.text.primary, lineHeight: 1.4 }}>
          {display.kind === 'spent' ? (
            <>You're out of free runs, connect a model in Settings to use <b>{display.label}</b>.</>
          ) : (
            <>Connect a provider in Settings to use <b>{display.label}</b>.</>
          )}
        </Box>
      </Box>
    </Fade>
  );
}

export default AgentChat;
