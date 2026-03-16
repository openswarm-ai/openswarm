import React, { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
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
  updateSessionModel,
  updateSessionMode,
  fetchSession,
  AgentMessage,
} from '@/shared/state/agentsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { createSessionWs } from '@/shared/ws/WebSocketManager';
import MessageBubble from './MessageBubble';
import ToolCallBubble, { ToolPair } from './ToolCallBubble';
import ToolGroupBubble, { RenderItem, ToolGroup, isToolGroup, isToolPair } from './ToolGroupBubble';
import ApprovalBar, { BatchApprovalBar } from './ApprovalBar';
import ChatInput, { ChatInputHandle } from './ChatInput';
import { ContextPath } from '@/app/components/DirectoryBrowser';
import BranchNavigator from './BranchNavigator';
import DiffViewer from './DiffViewer';
import { setGlowingBrowserCards, clearGlowingBrowserCards } from '@/shared/state/dashboardLayoutSlice';
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

interface AgentChatProps {
  sessionId?: string;
  onClose?: () => void;
  embedded?: boolean;
  initialContextPaths?: ContextPath[];
}

const AgentChat: React.FC<AgentChatProps> = ({ sessionId: sessionIdProp, onClose, embedded, initialContextPaths }) => {
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
  const [mode, setMode] = useState('agent');
  const [model, setModel] = useState('sonnet');

  const wsRef = useRef<ReturnType<typeof createSessionWs> | null>(null);
  const initialContextApplied = useRef(false);

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

  const prevStatusRef = useRef(session?.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = session?.status;
    prevStatusRef.current = curr;
    if (prev === 'running' && (curr === 'completed' || curr === 'stopped' || curr === 'error')) {
      if (id) dispatch(clearGlowingBrowserCards(id));
      const currentMode = modesMap[mode];
      if (currentMode?.default_next_mode && modesMap[currentMode.default_next_mode]) {
        setMode(currentMode.default_next_mode);
        if (id && !isDraft) {
          dispatch(updateSessionMode({ sessionId: id, mode: currentMode.default_next_mode as any }));
        }
      }
    }
  }, [session?.status, mode, modesMap, id, isDraft, dispatch]);

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
    if (isDraft) {
      const config: Record<string, any> = { model, mode };
      if (session?.system_prompt) config.system_prompt = session.system_prompt;
      if (session?.target_directory) config.target_directory = session.target_directory;
      dispatch(
        launchAndSendFirstMessage({ draftId: id, config, prompt, mode, model, images, contextPaths, forcedTools, attachedSkills })
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          if (selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: realId }));
          }
        }
      });
    } else {
      if (selectedBrowserIds?.length) {
        dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: id }));
      }
      dispatch(sendMessageThunk({ sessionId: id, prompt, mode, model, images, contextPaths, forcedTools, attachedSkills }));
    }
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

  const handleEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!id) return;
      dispatch(editMessage({ sessionId: id, messageId, content: newContent }));
    },
    [id, dispatch]
  );

  const activeBranchMessages = useMemo(() => {
    if (!session) return [];
    const branchId = session.active_branch_id || 'main';
    const branch = session.branches?.[branchId];

    if (!branch || !branch.fork_point_message_id) {
      return session.messages.filter((m) => m.branch_id === 'main' || m.branch_id === branchId);
    }

    const forkIdx = session.messages.findIndex((m) => m.id === branch.fork_point_message_id);
    const preMessages = session.messages
      .slice(0, forkIdx)
      .filter((m) => m.branch_id === (branch.parent_branch_id || 'main'));
    const branchMessages = session.messages.filter((m) => m.branch_id === branchId);
    return [...preMessages, ...branchMessages];
  }, [session?.messages, session?.active_branch_id, session?.branches]);

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
        items.push(msg);
        i++;
      }
    }
    return items;
  }, [activeBranchMessages]);

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
      return Object.values(session.branches)
        .filter((b) => b.fork_point_message_id === messageId)
        .map((b) => b.id);
    },
    [session?.branches]
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
                return <ToolGroupBubble key={item.id} group={item} isSessionRunning={sessionRunning} meta={groupMeta} />;
              }
              if (isToolPair(item)) {
                const isPending = item.result === null && sessionRunning;
                return <ToolCallBubble key={item.id} call={item.call} result={item.result} isPending={isPending} />;
              }
              const msg = item;
              const siblings = getSiblingBranches(msg.id);
              const hasBranches = siblings.length > 0;
              const currentBranchIdx = hasBranches
                ? siblings.indexOf(session.active_branch_id || 'main')
                : 0;

              return (
                <React.Fragment key={msg.id}>
                  <MessageBubble message={msg} onEdit={msg.role === 'user' ? handleEdit : undefined} />
                  {hasBranches && (
                    <BranchNavigator
                      currentIndex={Math.max(0, currentBranchIdx)}
                      totalBranches={siblings.length}
                      onPrevious={() => {
                        const prevBranch = siblings[Math.max(0, currentBranchIdx - 1)];
                        if (prevBranch && id) dispatch(switchBranch({ sessionId: id, branchId: prevBranch }));
                      }}
                      onNext={() => {
                        const nextBranch = siblings[Math.min(siblings.length - 1, currentBranchIdx + 1)];
                        if (nextBranch && id) dispatch(switchBranch({ sessionId: id, branchId: nextBranch }));
                      }}
                    />
                  )}
                </React.Fragment>
              );
            })}
            {session.streamingMessage && (
              session.streamingMessage.role === 'tool_call' ? (
                <ToolCallBubble
                  key={`streaming-${session.streamingMessage.id}`}
                  isStreaming
                  isPending
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
            {session.status === 'running' && !session.streamingMessage && (
              <ThinkingBubble />
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

        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          disabled={false}
          mode={mode}
          onModeChange={handleModeChange}
          model={model}
          onModelChange={handleModelChange}
          isRunning={!isDraft && (session.status === 'running' || session.status === 'waiting_approval')}
          onStop={handleStop}
          contextEstimate={contextEstimate}
          sessionId={id}
        />
      </Box>
    </Box>
  );
};

export default AgentChat;
