import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
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
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
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
} from '@/shared/state/agentsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { createSessionWs } from '@/shared/ws/WebSocketManager';
import MessageBubble from './MessageBubble';
import CompactionMarker from './CompactionMarker';
import MessageActionBar from './MessageActionBar';
import ToolCallBubble, { ToolPair } from './ToolCallBubble';
import ToolGroupBubble, { RenderItem, ToolGroup, isToolGroup, isToolPair } from './ToolGroupBubble';
import ApprovalBar, { BatchApprovalBar } from './ApprovalBar';
import ChatInput, { ChatInputHandle } from './ChatInput';
import ContextDrawer from './ContextDrawer';
import { ErrorSlime } from '@/app/components/ErrorSlime';
import { ContextPath } from '@/app/components/DirectoryBrowser';
import DiffViewer from './DiffViewer';
import { setGlowingBrowserCards, fadeGlowingBrowserCards, clearGlowingBrowserCards } from '@/shared/state/dashboardLayoutSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const CONTEXT_WINDOWS: Record<string, number> = {
  sonnet: 200_000,
  opus: 200_000,
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

const ThinkingBubble: React.FC<{ label?: string | null }> = ({ label }) => {
  const c = useClaudeTokens();
  const shimmerBase = c.text.tertiary;
  const shimmerHighlight = c.text.primary;
  // Aux-LLM-generated turn label takes priority; falls back to the
  // generic "Thinking…" verb if no label landed yet for this turn.
  const display = label ? `${label}…` : 'Thinking…';
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
  const dispatch = useAppDispatch();
  const session = useAppSelector((state) => (id ? state.agents.sessions[id] : undefined));
  const modesMap = useAppSelector((state) => state.modes.items);
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);
  const connectionMode = useAppSelector((state) => state.settings.data.connection_mode);
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
  const [mode, setMode] = useState('agent');
  const [model, setModel] = useState('sonnet');

  const wsRef = useRef<ReturnType<typeof createSessionWs> | null>(null);
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
    // checks `session.messages` to decide whether to drop deltas — so
    // if we connect first, the slice is empty when the replay arrives,
    // the guard returns false, and the user sees the chat type itself
    // out again. Awaiting fetchSession before connect makes the slice
    // authoritative before any replay event lands.
    (async () => {
      try {
        await dispatch(fetchSession(id));
      } catch {
        // Even if the REST hydrate fails, still connect — the WS resume
        // protocol can hydrate from buffered events as a fallback.
      }
      if (cancelled) return;
      ws = createSessionWs(id);
      ws.connect();
      wsRef.current = ws;
    })();
    return () => {
      cancelled = true;
      if (ws) ws.disconnect();
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
  const hasStreaming = !!session?.streamingMessage;

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
  const lastScrollHeightRef = useRef<number>(0);
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!isAtBottomRef.current) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      // Only set scrollTop when the scrollable height actually grew.
      // Otherwise we're forcing a paint for nothing — and on a
      // streaming turn we get one of these per delta, which thrashes
      // the compositor for zero visible benefit. The native
      // overflow-anchor on the container already keeps the viewport
      // pinned to the bottom; this JS fallback only needs to handle
      // the rare case where anchoring misses (legacy WebKit,
      // virtualized children, dynamic-height inserts).
      const newHeight = el.scrollHeight;
      if (newHeight === lastScrollHeightRef.current) return;
      lastScrollHeightRef.current = newHeight;
      el.scrollTop = newHeight;
    });
  }, [session?.messages.length, session?.streamingMessage?.content]);

  useEffect(() => () => {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  const handleSend = (prompt: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>, forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => {
    if (!id) return;
    // Sending a message is a clear intent signal: the user wants to see
    // the response. Force-scroll to bottom regardless of isAtBottomRef.
    scrollToBottom();
    const msg: QueuedMessage = { prompt, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds };
    if (agentBusy) {
      messageQueueRef.current.push(msg);
      setQueueLength(messageQueueRef.current.length);
      return;
    }
    dispatchMessage(msg);
  };

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

  const handleApprove = (requestId: string, updatedInput?: Record<string, any>) => {
    dispatch(handleApproval({ requestId, behavior: 'allow', updatedInput }));
  };

  const handleDeny = (requestId: string, message?: string) => {
    dispatch(handleApproval({ requestId, behavior: 'deny', message }));
  };

  const handleStop = () => {
    if (!id) return;
    dispatch(stopAgent({ sessionId: id }));
  };

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
    // Look up the actual context window from the models store (backend
    // registry is the source of truth). Fall back to the legacy hardcoded
    // map for any model that isn't in the store yet.
    let limit = 0;
    for (const ms of Object.values(modelsByProvider)) {
      const hit = ms.find((m) => m.value === model);
      if (hit?.context_window) { limit = hit.context_window; break; }
    }
    if (!limit) limit = CONTEXT_WINDOWS[model] || 200_000;
    let totalChars = 0;
    if (session?.system_prompt) totalChars += session.system_prompt.length;
    for (const msg of activeBranchMessages) {
      totalChars += stringifyContent(msg.content).length;
    }
    if (session?.streamingMessage) {
      totalChars += (session.streamingMessage.content || '').length;
    }
    const used = Math.round(totalChars / 4);
    return { used, limit };
  }, [activeBranchMessages, session?.system_prompt, session?.streamingMessage?.content, model, modelsByProvider]);

  const sessionRunning = session?.status === 'running' || session?.status === 'waiting_approval';

  const renderItems: RenderItem[] = useMemo(() => {
    const isOutputCall = (m: AgentMessage) =>
      m.role === 'tool_call' && typeof m.content === 'object' && m.content.tool === 'RenderOutput';
    const isOutputResult = (m: AgentMessage) => {
      if (m.role !== 'tool_result') return false;
      try {
        const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        return !!(parsed?.output_id && parsed?.frontend_code);
      } catch { return false; }
    };

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

        const regular: typeof activeBranchMessages = [];
        const outputItems: typeof activeBranchMessages = [];
        for (const m of group) {
          if (isOutputCall(m) || isOutputResult(m)) { outputItems.push(m); continue; }
          regular.push(m);
        }

        const calls = regular.filter((m) => m.role === 'tool_call');
        const results = regular.filter((m) => m.role === 'tool_result');
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

        items.push(...outputItems);
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
              borderBottom: `0.5px solid ${c.border.medium}`,
              bgcolor: c.bg.surface,
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography noWrap sx={{ color: c.text.primary, fontWeight: 600 }}>{session.name}</Typography>
                {!isDraft && statusStyle && (
                  <Chip
                    label={session.status.replace('_', ' ')}
                    size="small"
                    sx={{
                      bgcolor: statusStyle.bg,
                      color: statusStyle.color,
                      fontWeight: 600,
                      fontSize: '0.7rem',
                      height: 20,
                    }}
                  />
                )}
              </Box>
              {!isDraft && (
                <Box sx={{ display: 'flex', gap: 1.5, mt: 0.25, alignItems: 'center' }}>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {session.model}
                  </Typography>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {session.branch_name}
                  </Typography>
                  {(() => {
                    if (!(session.cost_usd > 0)) return null;
                    // The SDK reports a per-call $ figure regardless of how
                    // the request was routed. For requests that went through
                    // a subscription path, that figure is misleading — the
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
                          title="Routed through subscription — flat-rate, per-call cost not metered"
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
                    const pct = session.ctx_used_pct ?? 0;
                    if (!pct) return null;
                    const pctTxt = `${Math.round(pct * 100)}%`;
                    const color = pct >= 0.9 ? '#ef4444' : pct >= 0.7 ? '#f59e0b' : c.text.tertiary;
                    const mcpCount = session.active_mcps?.length ?? 0;
                    return (
                      <Typography
                        variant="caption"
                        sx={{ color, fontVariantNumeric: 'tabular-nums' }}
                        title={`Context ${pctTxt} of 200K · ${mcpCount} MCP${mcpCount === 1 ? '' : 's'} active`}
                      >
                        {pctTxt} ctx · {mcpCount} mcp
                      </Typography>
                    );
                  })()}
                </Box>
              )}
            </Box>
            {!isDraft && id && <DiffViewer sessionId={id} />}
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
              // Smoothness bundle (perf-only — no behavior change):
              //   1. overflow-anchor: auto — Chromium's native scroll
              //      anchoring keeps the viewport pinned to the user's
              //      visible content as siblings above/below resize.
              //      Eliminates the "transcript snaps back" feel during
              //      streaming and parallel tool fan-outs. Runs on the
              //      compositor thread, free.
              //   2. contain: layout — tells the browser layout shifts
              //      inside this scroll container don't affect siblings
              //      outside it. Prevents reflow from cascading up to
              //      the dashboard layout when bubbles grow.
              //   3. overscroll-behavior: contain — keeps over-scroll
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
              }}>
                <Typography variant="body2" sx={{ color: c.text.primary, fontWeight: 500, mb: 0.5 }}>
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
                        onClick={async () => {
                          try {
                            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                            const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
                            if (tok) headers['Authorization'] = `Bearer ${tok}`;
                            await fetch(`${API_BASE}/api/mcp-meta/activate`, {
                              method: 'POST',
                              headers,
                              body: JSON.stringify({
                                server_name: s.id.toLowerCase().replace(/\s+/g, '-'),
                                reason: s.reason || 'preflight suggestion',
                                parent_session_id: session.id,
                              }),
                            });
                          } catch { /* ignore */ }
                        }}
                        sx={{
                          cursor: 'pointer',
                          border: `1px solid ${c.border.medium}`,
                          borderRadius: 1,
                          px: 1.25,
                          py: 0.5,
                          bgcolor: 'transparent',
                          color: c.text.primary,
                          '&:hover': { bgcolor: c.bg.elevated },
                          flexShrink: 0,
                        }}
                      >
                        Activate
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            )}
            {session.context_overflow && (() => {
              const reason = session.context_overflow.reason;
              const isAuth = reason === 'openswarm_pro_auth_expired' || reason === 'anthropic_auth_invalid' || reason === 'auth_error';
              const title = isAuth ? 'Sign-in required' : 'Context full';
              const primaryLabel = isAuth ? 'Open Settings' : 'Start a fresh chat';
              const onPrimary = () => {
                if (isAuth) window.location.hash = '#/settings';
                else window.location.hash = '#/';
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
            {renderItems.filter((item) => !session.streamingMessage || item.id !== session.streamingMessage.id).map((item) => {
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
                    <ToolCallBubble call={item.call} result={item.result} isPending={isPending} sessionId={session.id} />
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
                <Box key={msg.id} sx={{ '&:hover .msg-actions': { opacity: 1 } }}>
                  <MessageBubble
                    message={msg}
                    editing={isEditing}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                  />
                  {!isEditing && (msg.role === 'user' || (msg.role === 'assistant' && lastAssistantIdsInTurn.has(msg.id))) && (
                    <MessageActionBar
                      role={msg.role as 'user' | 'assistant'}
                      onCopy={() => navigator.clipboard.writeText(rawText)}
                      onEdit={msg.role === 'user' ? () => setEditingMessageId(msg.id) : undefined}
                      onRegenerate={msg.role === 'assistant' ? () => handleRegenerate(msg) : undefined}
                      onBranch={msg.role === 'assistant' ? () => handleBranchChat(msg.id) : undefined}
                      branchNav={
                        hasBranches
                          ? {
                              currentIndex: Math.max(0, currentBranchIdx),
                              totalBranches: siblings.length,
                              onPrevious: () => {
                                const prevBranch = siblings[Math.max(0, currentBranchIdx - 1)];
                                if (prevBranch && id) dispatch(switchBranch({ sessionId: id, branchId: prevBranch }));
                              },
                              onNext: () => {
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
            {session.streamingMessage && (
              session.streamingMessage.role === 'tool_call' ? (
                <ToolCallBubble
                  key={`streaming-${session.streamingMessage.id}`}
                  isStreaming
                  isPending
                  sessionId={session.id}
                  call={{
                    id: session.streamingMessage.id,
                    role: 'tool_call',
                    content: { tool: session.streamingMessage.tool_name || '', input: session.streamingMessage.content },
                    timestamp: new Date().toISOString(),
                    branch_id: session.active_branch_id || 'main',
                    parent_id: null,
                  }}
                />
              ) : (
                <MessageBubble
                  key={`streaming-${session.streamingMessage.id}`}
                  isStreaming
                  dynamicTurnLabel={session.turn_label?.label}
                  message={{
                    id: session.streamingMessage.id,
                    role: session.streamingMessage.role,
                    content: session.streamingMessage.content,
                    timestamp: new Date().toISOString(),
                    branch_id: session.active_branch_id || 'main',
                    parent_id: null,
                  }}
                />
              )
            )}
            {(awaitingResponse || (session.status === 'running' && !session.streamingMessage)) && (
              <ThinkingBubble label={session.turn_label?.label} />
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
              animation: 'continue-chat-glow 2s ease-in-out infinite',
              transition: 'background 0.15s, box-shadow 0.15s',
              '@keyframes continue-chat-glow': {
                '0%, 100%': {
                  boxShadow: `0 0 12px ${c.accent.primary}25, inset 0 0 12px ${c.accent.primary}08`,
                },
                '50%': {
                  boxShadow: `0 0 20px ${c.accent.primary}40, inset 0 0 20px ${c.accent.primary}15`,
                },
              },
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
                        apps (Microsoft 365 is the heaviest) or switch to Sonnet/Opus —
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
              />
            </Box>
          </ClickAwayListener>
        )}
      </Box>
    </Box>
  );
};

export default AgentChat;
