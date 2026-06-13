import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import ClickAwayListener from '@mui/material/ClickAwayListener';
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
import { openSettingsModal } from '@/shared/state/settingsSlice';
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
import MessageBubble from './bubbles/MessageBubble';
import CompactionMarker from './bubbles/CompactionMarker';
import MessageActionBar from './shell/MessageActionBar';
import ToolCallBubble, { ToolPair } from './tool-bubbles/ToolCallBubble';
import ToolGroupBubble, { RenderItem, ToolGroup, isToolGroup, isToolPair } from './tool-bubbles/ToolGroupBubble';
import ApprovalBar, { BatchApprovalBar } from './shell/ApprovalBar';
import ChatInput, { ChatInputHandle } from './ChatInput';
import ContextDrawer from './shell/ContextDrawer';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { setGlowingBrowserCards, fadeGlowingBrowserCards, clearGlowingBrowserCards } from '@/shared/state/dashboardLayoutSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const CONTEXT_WINDOWS: Record<string, number> = {
  'opus-4-8': 1_000_000,
  'opus-4-7': 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
};

function stringifyContent(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

const thinkingShimmerKeyframes = `
@keyframes thinking-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
`;

// Single-word labels picked deterministically per session-turn so the pill
// has variety without flickering between renders. Mirrors MessageBubble's list.
const STREAMING_LABELS: ReadonlyArray<string> = [
  'Thinking', 'Pondering', 'Cooking', 'Marinating', 'Deliberating',
  'Reasoning', 'Reflecting', 'Untangling', 'Stewing', 'Locking-in',
  'Considering', 'Processing', 'Vibing', 'Calculating', 'Chefing',
  'Geeking', 'Brewing',
];

function streamingLabelFor(seedKey: string | undefined): string {
  if (!seedKey) return STREAMING_LABELS[0];
  let h = 0;
  for (let i = 0; i < seedKey.length; i++) {
    h = ((h << 5) - h + seedKey.charCodeAt(i)) | 0;
  }
  return STREAMING_LABELS[Math.abs(h) % STREAMING_LABELS.length];
}

const ThinkingBubble: React.FC<{ label?: string | null; seedKey?: string }> = ({ label, seedKey }) => {
  const c = useClaudeTokens();
  const shimmerBase = c.text.tertiary;
  const shimmerHighlight = c.text.primary;
  // Aux-LLM label wins; otherwise pick a quirky verb keyed off seedKey
  // so different sessions / turns show different verbs without flicker.
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
}

const AgentChat: React.FC<AgentChatProps> = ({ sessionId: sessionIdProp, onClose, embedded, autoFocus, isGlowing, onDismissGlow, initialContextPaths, onBranch }) => {
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
  const navigate = useNavigate();
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
  // Used by the "too many connected apps for Haiku" warning rendered above
  // ChatInput. Each connected MCP adds a meaningful chunk of tool-schema
  // tokens to every request; Haiku 4.5's 200K window can't hold 5+ of them.
  const toolItems = useAppSelector((state) => state.tools.items);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showResumeBubble, setShowResumeBubble] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [preSendActivityLabel, setPreSendActivityLabel] = useState<string | null>(null);
  const [activatingMcp, setActivatingMcp] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [mode, setMode] = useState('agent');
  const [model, setModel] = useState('sonnet');

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

  useEffect(() => {
    if (!id || isDraft) return;
    let cancelled = false;
    let ws: ReturnType<typeof createSessionWs> | null = null;
    // Order matters: hydrate the persisted message list from REST FIRST,
    // THEN connect the WS. The WS resume protocol replays buffered
    // events starting at last_seq=0, which includes every stream_*
    // event for messages that finished before the disconnect. The
    // replay-skip guard in WebSocketManager._messageAlreadyComplete
    // checks `session.messages` to decide whether to drop deltas , so
    // if we connect first, the slice is empty when the replay arrives,
    // the guard returns false, and the user sees the chat type itself
    // out again. Awaiting fetchSession before connect makes the slice
    // authoritative before any replay event lands.
    (async () => {
      // The await exists so the slice isn't EMPTY at replay time. A warm store
      // (remount after a hop) already satisfies that, so connect immediately and
      // let the fetch reconcile in the background; awaiting serialized a slow
      // round trip in front of the live stream on every reopen.
      const warm = !!store.getState().agents.sessions[id]?.messages?.length;
      if (warm) {
        dispatch(fetchSession(id));
      } else {
        try {
          await dispatch(fetchSession(id));
        } catch {
          // Even if the REST hydrate fails, still connect , the WS resume
          // protocol can hydrate from buffered events as a fallback.
        }
      }
      if (cancelled) return;
      // acquireSessionWs reuses a still-open socket kept alive from the last hop,
      // so an active agent's stream resumes with no reconnect handshake. connect()
      // is a no-op when the reused socket is already open.
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
      dispatch(
        launchAndSendFirstMessage({ draftId: id, config, prompt: msg.prompt, mode, model, images: msg.images, contextPaths: msg.contextPaths, forcedTools: msg.forcedTools, attachedSkills: msg.attachedSkills, selectedBrowserIds: msg.selectedBrowserIds })
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt: msg.prompt }));
          if (msg.selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));
          }
        }
      });
    } else {
      if (msg.selectedBrowserIds?.length) {
        dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: id, label: 'Use Browser' }));
      }
      dispatch(sendMessageThunk({ sessionId: id, prompt: msg.prompt, mode, model, images: msg.images, contextPaths: msg.contextPaths, forcedTools: msg.forcedTools, attachedSkills: msg.attachedSkills, selectedBrowserIds: msg.selectedBrowserIds }))
        .then((action) => {
          if (sendMessageThunk.rejected.match(action)) {
            setAwaitingResponse(false);
          }
        });
    }
  }, [id, isDraft, mode, model, session?.system_prompt, session?.target_directory, dispatch]);

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
        setTimeout(() => dispatch(clearGlowingBrowserCards(id)), 2800);
      }

      const nextQueued = messageQueueRef.current.shift();
      if (nextQueued) {
        setQueueLength(messageQueueRef.current.length);
        dispatchMessage(nextQueued);
        didDispatchQueued = true;
      } else {
        if (curr === 'stopped') {
          setShowResumeBubble(true);
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
  }, [session?.status, mode, modesMap, id, isDraft, dispatch, dispatchMessage]);

  // Idle reconcile: if the session has been 'running' for 5s with no
  // WebSocket activity (no new messages, no streaming updates), do a
  // single GET to fetch the real status from the backend. Catches the
  // case where the completion WebSocket event was dropped (network blip,
  // sleep/wake, SDK subprocess dying). Resets on every activity signal
  // so it never fires during normal streaming.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageCount = session?.messages?.length ?? 0;
  // Subscribe only to the streaming MESSAGE ID (stable across the 30Hz
  // delta updates), never to the content. The actual streaming text
  // renders inside the leaf <StreamingBubble> below, which subscribes to
  // the content itself. This keeps AgentChat's render and useEffects
  // dormant during streaming; only the bubble updates per delta.
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

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  // Prevent scroll from leaking into the dashboard canvas when at boundaries
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Pinch-to-zoom (ctrl/meta + wheel) must reach the canvas viewport so
      // the dashboard zooms when the cursor is over an agent's chat panel.
      // Without this early-out the unconditional stopPropagation below kills
      // ctrl+wheel and the canvas listener never fires.
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

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  const scrollRafRef = useRef<number | null>(null);
  const pinRafRef = useRef<number | null>(null);
  const lastScrollHeightRef = useRef<number>(0);
  // Shared scroll-stick routine. Used both by the structural-events
  // useEffect below (new message lands / stream starts/ends) and by
  // StreamingBubble's onStreamGrew callback (per-delta growth). RAF +
  // height-grew gate ensures we only set scrollTop when needed.
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
    // Structural triggers only: a new message lands or a stream
    // starts/ends. Streaming content updates trigger this via
    // <StreamingBubble onStreamGrew={stickToBottomIfNeeded} /> instead
    // so AgentChat stays dormant during the 30Hz delta storm.
  }, [session?.messages.length, streamingMessageId, stickToBottomIfNeeded]);

  // Stream-end re-stick. When a stream finishes, the live bubble (smooth-revealed
  // text) is replaced by the committed bubble rendering FULL markdown with
  // contentVisibility placeholders; as those resolve, Chromium's overflow-anchor
  // re-anchors to an EARLIER element (the user message), yanking the view up to
  // "the top of the user input". A single deferred scroll loses the race because
  // that anchor shift fires an onScroll that flips isAtBottomRef false before we
  // run. Fix: snapshot the "was following" intent the moment streaming stops
  // (captured continuously during the stream, before any completion re-render),
  // then pin to bottom across a short multi-frame window that OVERRIDES the
  // layout-induced flip. A genuine user scroll-away (wheel/touch) during that
  // window aborts the pin, honoring "unless the user scrolls up".
  const prevStreamingIdRef = useRef<string | null>(null);
  const wasFollowingRef = useRef(true);
  const pinAbortRef = useRef(false);
  // Keep the follow-intent fresh while streaming so it's accurate at the instant
  // the stream ends (handleScroll updates isAtBottomRef on every real scroll).
  if (streamingMessageId) wasFollowingRef.current = isAtBottomRef.current;
  useEffect(() => {
    const prev = prevStreamingIdRef.current;
    prevStreamingIdRef.current = streamingMessageId;
    if (!(prev && !streamingMessageId)) return;
    if (!wasFollowingRef.current) return; // user had scrolled up; leave them be
    pinAbortRef.current = false;
    const el = scrollContainerRef.current;
    if (!el) return;
    // Abort the pin only on a deliberate scroll-away gesture, not the
    // layout-induced onScroll the commit itself triggers.
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

  // A tool's live pill is already on screen when it commits, so re-running the
  // mount reveal on the committed bubble flashes the exact same row. Remember the
  // id that just stopped streaming for a beat and let that one bubble skip its
  // entrance, so the hand-off is seamless. 500ms is slack for the commit render
  // to land after the stream clears (they don't always arrive on the same frame).
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
  }, []);

  // useCallback so ChatInput's memo equality holds across AgentChat
  // re-renders driven by unrelated session state. Captures agentBusy
  // through the dependency so a stale "busy" closure doesn't ever route
  // a message past the queue.
  const handleSend = useCallback(
    (
      prompt: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>,
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
    ) => {
      if (!id) return;
      scrollToBottom();
      const msg: QueuedMessage = { prompt, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds };
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
    setModel(newModel);
    if (id && !isDraft) dispatch(updateSessionModel({ sessionId: id, model: newModel }));
  }, [id, isDraft, dispatch]);

  const handleThinkingLevelChange = useCallback((level: 'off' | 'low' | 'medium' | 'high' | 'auto') => {
    if (!id) return;
    dispatch(updateSessionThinkingLevel({ sessionId: id, level }));
    if (!isDraft) dispatch(updateThinkingLevel({ sessionId: id, level }));
  }, [id, isDraft, dispatch]);

  const handleApprove = (requestId: string, updatedInput?: Record<string, any>, trustPattern?: boolean) => {
    dispatch(handleApproval({ requestId, behavior: 'allow', updatedInput, trustPattern }));
  };

  const handleDeny = (requestId: string, message?: string) => {
    dispatch(handleApproval({ requestId, behavior: 'deny', message }));
  };

  const handleStop = useCallback(() => {
    if (!id) return;
    dispatch(stopAgent({ sessionId: id }));
  }, [id, dispatch]);

  const handleResume = useCallback(() => {
    if (!id) return;
    setShowResumeBubble(false);
    dispatch(sendMessageThunk({
      sessionId: id,
      prompt: "Continue where you left off. Start you're response EXACTLY with 'Sorry, let me pick up where I left off",
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
    // Prefer the live API-reported input token count once we have one
    // (session.tokens.input includes the full request: messages + system +
    // tool defs + cached prefix). That number is authoritative because
    // Anthropic counts it against the context window. Before the first
    // turn completes, fall back to a char/4 estimate of visible message
    // content as a rough pre-send hint.
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
    // Streaming content's contribution to the context estimate is no
    // longer included here: we'd have to subscribe to the streaming
    // text and re-run this sum on every painted character, defeating
    // the whole point of isolating AgentChat from delta updates. The
    // header gauge will catch up when stream_end commits the message.
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
        const allSameMcp = mcpServers.size === 1 && pairs.length > 0;

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
          const summary = typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120);
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
          const summary = typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120);
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

  const isActive = session.status === 'running' || session.status === 'waiting_approval' || session.status === 'draft';
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
              // No seam: the header is just a band of typography inside the chat
              // panel; transparent bg + air carry it, no hairline. (An earlier
              // bg.surface here read lighter than the body and pulled focus.)
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
              {!isDraft && (
                <Box sx={{ display: 'flex', gap: 1.5, mt: 0.25, alignItems: 'center' }}>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {resolveModelLabel(session.model)}
                  </Typography>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {session.branch_name}
                  </Typography>
                  {(() => {
                    if (!(session.cost_usd > 0)) return null;
                    // The SDK reports a per-call $ figure regardless of how
                    // the request was routed. For requests that went through
                    // a subscription path, that figure is misleading , the
                    // user pays flat-rate. Show "subscription" instead in
                    // those cases. Show $ only when the call was actually
                    // metered (Anthropic API key, OpenAI API key, etc.).
                    //
                    // Model-id signals (these are short_name values from the
                    // BUILTIN_MODELS registry):
                    //   - `*-api` → pinned Anthropic API key (METERED)
                    //   - `*-cc` → pinned Claude Pro/Max via 9Router (sub)
                    //   - plain sonnet/opus/haiku + openswarm-pro mode → Pro proxy (sub)
                    //   - plain sonnet/opus/haiku + own_key mode → API key (METERED)
                    //   - gpt-5.4* / gpt-5.3* → ChatGPT Plus/Pro via 9Router (sub)
                    //   - gemini-*  → Gemini Advanced via 9Router (sub)
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
                    const liveWindow = session.context_window || contextEstimate.limit || 200_000;
                    const liveInput = session.tokens?.input ?? 0;
                    const pct = liveInput > 0
                      ? Math.min(1, liveInput / Math.max(1, liveWindow))
                      : (contextEstimate.used / Math.max(1, liveWindow));
                    const mcpCount = session.active_mcps?.length ?? 0;
                    // Quiet until it matters: hide the memory meter until the chat is filling up,
                    // and hide the tool count unless tools are actually connected.
                    const showMemory = pct >= 0.60;
                    const showTools = mcpCount > 0;
                    if (!showMemory && !showTools) return null;
                    const pctTxt = `${Math.round(pct * 100)}%`;
                    const memColor = pct >= 0.85 ? '#ef4444' : '#f59e0b';
                    const tip = [
                      showMemory ? `Memory ${pctTxt} full. As the chat fills up, the oldest messages start dropping out.` : null,
                      showTools ? `${mcpCount} tool${mcpCount === 1 ? '' : 's'} connected.` : null,
                    ].filter(Boolean).join('\n');
                    return (
                      <Typography
                        variant="caption"
                        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontVariantNumeric: 'tabular-nums' }}
                        title={tip}
                      >
                        {showMemory && (
                          <Box component="span" sx={{ color: memColor, fontWeight: 500 }}>
                            Memory {pctTxt} full
                          </Box>
                        )}
                        {showMemory && showTools && (
                          <Box component="span" sx={{ color: c.text.ghost }}>·</Box>
                        )}
                        {showTools && (
                          <Box component="span" sx={{ color: c.text.tertiary }}>
                            {mcpCount} tool{mcpCount === 1 ? '' : 's'}
                          </Box>
                        )}
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
              px: 2,
              py: 1,
              // Smoothness bundle (perf-only , no behavior change):
              //   1. overflow-anchor: auto , Chromium's native scroll
              //      anchoring keeps the viewport pinned to the user's
              //      visible content as siblings above/below resize.
              //      Eliminates the "transcript snaps back" feel during
              //      streaming and parallel tool fan-outs. Runs on the
              //      compositor thread, free.
              //   2. contain: layout , tells the browser layout shifts
              //      inside this scroll container don't affect siblings
              //      outside it. Prevents reflow from cascading up to
              //      the dashboard layout when bubbles grow.
              //   3. overscroll-behavior: contain , keeps over-scroll
              //      gestures from leaking up to the dashboard pan/zoom
              //      when the user hits the chat top/bottom.
              overflowAnchor: 'auto',
              contain: 'layout',
              overscrollBehavior: 'contain',
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
              '&::-webkit-scrollbar-thumb': {
                background: c.border.medium,
                borderRadius: 3,
                '&:hover': { background: c.border.strong },
              },
              scrollbarWidth: 'thin',
              scrollbarColor: `${c.border.medium} transparent`,
            }}
          >
            {(session.mcp_suggestions && session.mcp_suggestions.length > 0) && (
              <Box sx={{
                mt: 1,
                mb: 1.5,
                p: 1.5,
                borderRadius: 1.5,
                border: `1px solid ${c.border.medium}`,
                bgcolor: c.bg.secondary,
                position: 'relative',
              }}>
                <Box
                  role="button"
                  aria-label="Dismiss integration suggestion"
                  onClick={() => id && dispatch(clearMcpSuggestions({ sessionId: id }))}
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
                  {session.mcp_suggestions.map((s) => (
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
                              // Not yet connected; jump straight to Actions
                              // so the user can finish OAuth. Nothing here
                              // can do it on their behalf.
                              navigate('/actions');
                            } else if (id) {
                              // Activation succeeded; clear the banner so the user
                              // gets visual confirmation the click did something.
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
            )}
            {session.context_overflow && (() => {
              const reason = session.context_overflow.reason;
              const isAuth = reason === 'openswarm_pro_auth_expired' || reason === 'anthropic_auth_invalid' || reason === 'auth_error';
              const title = isAuth ? 'Sign-in required' : 'Context full';
              const primaryLabel = isAuth ? 'Open Settings' : 'Start a fresh chat';
              const onPrimary = () => {
                if (isAuth) {
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
                    {session.context_overflow.message}
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
            {renderItems.filter((item) => !streamingMessageId || item.id !== streamingMessageId).map((item) => {
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
                  <React.Fragment key={item.id}>
                    <ToolGroupBubble group={item} isSessionRunning={sessionRunning} meta={groupMeta} sessionId={session.id} />
                    {compactionChip}
                  </React.Fragment>
                );
              }
              if (isToolPair(item)) {
                const isPending = item.result === null && sessionRunning;
                return (
                  <React.Fragment key={item.id}>
                    <ToolCallBubble call={item.call} result={item.result} isPending={isPending} sessionId={session.id} suppressReveal={item.call.id === justStreamedId} />
                    {compactionChip}
                  </React.Fragment>
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
                <Box
                  key={msg.id}
                  sx={{
                    '&:hover .msg-actions': { opacity: 1 },
                    // Cheap virtualization: tells the browser to skip
                    // paint + layout for bubbles outside the scroll
                    // viewport. `contain-intrinsic-size: auto N` reserves
                    // a placeholder height so the scrollbar doesn't jump,
                    // and `auto` lets the browser remember the actual
                    // height after first render. Works alongside the
                    // container's overflow-anchor. Chrome 85+ (Electron
                    // covers this).
                    contentVisibility: 'auto',
                    containIntrinsicSize: 'auto 120px',
                  }}
                >
                  <MessageBubble
                    message={msg}
                    editing={isEditing}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
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
              );
            })}
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
            {(preSendActivityLabel || awaitingResponse || (session.status === 'running' && !streamingMessageId)) && (
              <Box sx={{ overflowAnchor: 'none' }}>
                <ThinkingBubble
                  label={preSendActivityLabel || session.turn_label?.label}
                  seedKey={`${session.id}:${session.messages?.length ?? 0}`}
                />
              </Box>
            )}
            {showResumeBubble && session.status === 'stopped' && (
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
                // Proactive Haiku-overflow warning. Each connected MCP adds
                // a sizeable tools-schema chunk to every Claude request;
                // Haiku 4.5's window is 5x smaller than Sonnet/Opus, so 5+
                // simultaneously-enabled MCPs reliably push a one-line
                // message past the limit. We surface this BEFORE the user
                // sends so they don't waste a turn on "Prompt is too long".
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
                thinkingLevel={session?.thinking_level ?? 'auto'}
                onThinkingLevelChange={handleThinkingLevelChange}
                onActivityLabelChange={setPreSendActivityLabel}
              />
            </Box>
          </ClickAwayListener>
        )}
      </Box>
    </Box>
  );
};

export default AgentChat;
