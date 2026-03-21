import React, { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback } from 'react';
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
  fetchSession,
  AgentMessage,
} from '@/shared/state/agentsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { createSessionWs } from '@/shared/ws/WebSocketManager';
import MessageBubble from './MessageBubble';
import MessageActionBar from './MessageActionBar';
import ToolCallBubble, { ToolPair } from './ToolCallBubble';
import ToolGroupBubble, { RenderItem, ToolGroup, isToolGroup, isToolPair } from './ToolGroupBubble';
import ApprovalBar, { BatchApprovalBar } from './ApprovalBar';
import ChatInput, { ChatInputHandle } from './ChatInput';
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

const thinkingDotsKeyframes = `
@keyframes thinking-bounce {
  0%, 80%, 100% { transform: scale(0); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
`;

const ThinkingBubble: React.FC = () => {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start', my: 0.75 }}>
      <style>{thinkingDotsKeyframes}</style>
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
          gap: '4px',
          minHeight: 36,
        }}
      >
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            sx={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: c.text.tertiary,
              animation: 'thinking-bounce 1.4s infinite ease-in-out both',
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
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
    const ws = createSessionWs(id);
    ws.connect();
    wsRef.current = ws;
    dispatch(fetchSession(id));
    return () => {
      ws.disconnect();
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

  const SCROLL_THRESHOLD = 50;

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  useLayoutEffect(() => {
    if (isAtBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [session?.messages.length, session?.streamingMessage?.content]);

  const handleSend = (prompt: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>, forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => {
    if (!id) return;
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
    const limit = CONTEXT_WINDOWS[model] || 200_000;
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
  }, [activeBranchMessages, session?.system_prompt, session?.streamingMessage?.content, model]);

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
                <Box sx={{ display: 'flex', gap: 1.5, mt: 0.25 }}>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {session.model}
                  </Typography>
                  <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                    {session.branch_name}
                  </Typography>
                  {session.cost_usd > 0 && (
                    <Typography variant="caption" sx={{ color: c.accent.primary }}>
                      ${session.cost_usd.toFixed(4)}
                    </Typography>
                  )}
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
            {renderItems.map((item) => {
              if (isToolGroup(item)) {
                const groupMeta = session.tool_group_meta?.[item.id];
                return <ToolGroupBubble key={item.id} group={item} isSessionRunning={sessionRunning} meta={groupMeta} sessionId={session.id} />;
              }
              if (isToolPair(item)) {
                const isPending = item.result === null && sessionRunning;
                return <ToolCallBubble key={item.id} call={item.call} result={item.result} isPending={isPending} sessionId={session.id} />;
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
              <ThinkingBubble />
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
              />
            </Box>
          </ClickAwayListener>
        )}
      </Box>
    </Box>
  );
};

export default AgentChat;
