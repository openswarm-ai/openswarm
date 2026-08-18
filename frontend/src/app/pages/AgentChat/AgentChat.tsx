import React, { useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import type { WorkflowsRunContext } from '@/shared/state/dashboardLayoutSlice';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { useWelcomeGreeting } from './useWelcomeGreeting';
import { composerPlaceholder } from './composerPlaceholder';
import { useBurstRevealTracking } from './bubbles/useBurstRevealTracking';
import { useDockedBrowserSlot } from './shell/useDockedBrowserSlot';
import { useJustStreamed } from './streaming/useJustStreamed';
import { WorkflowModelNotice, FreeTrialModelNotice } from './model/ModelNotices';
import { useMcpActivation } from './model/useMcpActivation';
import { useMessageQueue, type QueuedMessage } from './queue/useMessageQueue';
import { QueuePanel } from './queue/QueuePanel';
import { AgentChatHeader } from './render/AgentChatHeader';
import { useMessageScroll } from './scroll/useMessageScroll';
import { FULLSCREEN_READING_MAX_W, MessageListBody } from './scroll/MessageListBody';
import { TranscriptItem, type TranscriptItemVm } from './transcript/TranscriptItem';
import { TranscriptFooter } from './transcript/TranscriptFooter';
import { ContextOverflowCard } from './transcript/ContextOverflowCard';
import { useTranscriptDerivations } from './transcript/useTranscriptDerivations';
import { useToolGroupMeta } from './transcript/useToolGroupMeta';
import { useBranchActions } from './transcript/useBranchActions';
import { useSessionWs } from './session/useSessionWs';
import { useSendPipeline } from './session/useSendPipeline';
import { useModeModel } from './session/useModeModel';
import { useWorkflowSidecar } from './session/useWorkflowSidecar';
import { HaikuMcpWarning } from './composer/HaikuMcpWarning';
import { McpSuggestionsBanner } from './composer/McpSuggestionsBanner';
import { ContinueChatGlow } from './composer/ContinueChatGlow';
import { PendingApprovalBars } from './shell/PendingApprovalBars';
import ForceStopAgentBar from './ForceStopAgentBar';
import { ProviderRetryPill, RateLimitPill } from './shell/RateLimitPill';
import { ContextRecoveredPill } from './shell/ContextRecoveredPill';
import ChatInput, { ChatInputHandle } from './ChatInput';
import { useInitialContextPaths } from './ChatInput/hooks/useInitialContextPaths';
import FollowupChips from './FollowupChips';
import ContextDrawer from './shell/ContextDrawer';

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
  // Full size view: center the whole chat in a reading column so an expanded card reads like a chat page.
  fullscreenChat?: boolean;
  // One-shot text to drop into the composer (e.g. a run attached as context).
  prefillPrompt?: string;
  // A workflow run attached as a removable context chip above the composer; while present, each send routes through onSendRunQuestion so the run's transcript rides along as hidden context for that turn.
  runContext?: WorkflowsRunContext;
  onClearRunContext?: () => void;
  onSendRunQuestion?: (prompt: string, runId: string) => Promise<void>;
}

// The chat orchestrator (AGENTCHAT_SPLIT_PLAN done-state): wires the session/ hooks (transport, send pipeline, mode/model, workflow sidecar),
// the transcript/ derivations + actions, and the scroll/ mechanism into the header / transcript / approvals / composer render. Composition only.
const AgentChat: React.FC<AgentChatProps> = ({ sessionId: sessionIdProp, onClose, embedded, autoFocus, isGlowing, onDismissGlow, initialContextPaths, onBranch, workflowEditId, readOnly, fullscreenChat, prefillPrompt, runContext, onClearRunContext, onSendRunQuestion }) => {
  const c = useClaudeTokens();
  // Fullscreen is a flat theme ground, same as Claude's: the old accent wash from the top read as decoration and dated the whole surface.
  const { mode: themeMode } = useThemeMode();
  const fullscreenWash = fullscreenChat ? (themeMode === 'dark' ? '#1a1918' : '#F5F5F0') : undefined;
  const { id: routeId } = useParams<{ id: string }>();
  const id = sessionIdProp || routeId;
  const dispatch = useAppDispatch();
  const session = useAppSelector((state) => (id ? state.agents.sessions[id] : undefined));
  const connectionMode = useAppSelector((state) => state.settings.data.connection_mode);
  const { isStoppableSidecar, isWorkflowRunSidecar, testState, handleStop, onTestContinueEditing, onTestSaveWorkflow } = useWorkflowSidecar(id);

  const chatInputRef = useRef<ChatInputHandle>(null);
  const mcpActivation = useMcpActivation(dispatch, id);
  const queue = useMessageQueue();

  const isDraft = session?.status === 'draft';
  const { greetingDone: welcomeGreetingDone } = useWelcomeGreeting(session, isDraft);

  const {
    mode, setMode, model, modesMap, resolveModelLabel,
    handleModeChange, handleModelChange, handleThinkingLevelChange,
    workflowNotice, freeTrialNotice,
  } = useModeModel({ id, isDraft, session, workflowEditId, connectionMode });

  // Subscribe only to the streaming MESSAGE ID (stable across the 30Hz delta updates), never to the content. The actual streaming text renders inside the leaf <StreamingBubble> (TranscriptFooter), which subscribes to the content itself. This keeps AgentChat's render and useEffects dormant during streaming; only the bubble updates per delta.
  const streamingMessageId = useAppSelector((s) => id ? s.streaming.bySession[id]?.id ?? null : null);
  const hasStreaming = !!streamingMessageId;
  const justStreamedId = useJustStreamed(streamingMessageId);

  useSessionWs(id, isDraft, session?.status, { messageCount: session?.messages?.length ?? 0, hasStreaming });

  useInitialContextPaths(chatInputRef, initialContextPaths);

  const {
    dispatchMessage, agentBusy, awaitingResponse, showResumeBubble,
    preSendActivityLabel, setPreSendActivityLabel, handleResume, handleResetHistory,
  } = useSendPipeline({ id, isDraft, session, mode, model, setMode, modesMap, queue, isWorkflowRunSidecar, streamingMessageId, onSendRunQuestion });

  const sessionRunning = session?.status === 'running' || session?.status === 'waiting_approval';
  const { activeBranchMessages, renderItems, lastAssistantIdsInTurn, lastPendingAskCallId, contextEstimate, getSiblingBranches } =
    useTranscriptDerivations({ session, model, streamingMessageId, sessionRunning });
  const { browserAnchorItemId, browserSlot } = useDockedBrowserSlot({ id, c, renderItems });
  const seenMessageIds = useBurstRevealTracking(id, session?.active_branch_id);

  const scroll = useMessageScroll({
    renderItems,
    streamingMessageId,
    sessionId: session?.id,
    activeBranchId: session?.active_branch_id,
    messagesLength: session?.messages?.length,
    id,
  });
  // Destructure ONLY the stable useCallback'd members that feed dep arrays / memoized children
  // (callback-identity rule: never put the hook object itself in a dep array).
  const { scrollToBottom, stickToBottomIfNeeded } = scroll;

  // Read live in the stable handleSend closure without busting its memo (ChatInput leans on handleSend identity holding across renders).
  const runContextRef = useRef(runContext);
  runContextRef.current = runContext;

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
        queue.enqueue(msg);
        return;
      }
      dispatchMessage(msg);
    },
    [id, scrollToBottom, agentBusy, dispatchMessage],
  );

  useToolGroupMeta(id, isDraft, renderItems, session?.tool_group_meta);

  const {
    editingMessageId, setEditingMessageId, handleSaveEdit, handleCancelEdit,
    handleRegenerate, handleBranchChat, handleSwitchBranch,
  } = useBranchActions({ id, session, activeBranchMessages, onBranch });

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
  // Structured view model for the per-item transcript render (TranscriptItem); rebuilt each render,
  // same staleness semantics as the previously-inline closures.
  const itemVm: TranscriptItemVm = {
    session, id, c, renderItems, sessionRunning, awaitingResponse, justStreamedId, lastPendingAskCallId, seenMessageIds,
    editingMessageId, lastAssistantIdsInTurn, branchNavLocked,
    viewportHeight: scroll.viewportHeight,
    viewportWidth: scroll.viewportWidth,
    scrollRoot: scroll.scrollRoot,
    getSiblingBranches,
    onSaveEdit: handleSaveEdit,
    onCancelEdit: handleCancelEdit,
    onStartEdit: setEditingMessageId,
    onRegenerate: handleRegenerate,
    onBranch: handleBranchChat,
    onSwitchBranch: handleSwitchBranch,
    onStreamGrew: stickToBottomIfNeeded,
  };

  return (
    <Box sx={{ display: 'flex', height: '100%', ...(fullscreenWash && { background: fullscreenWash }) }}>
      <ContextDrawer />
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden', ...(fullscreenChat && { maxWidth: FULLSCREEN_READING_MAX_W, width: '100%', mx: 'auto' }) }}>
        {!embedded && (
          <AgentChatHeader
            session={session}
            isDraft={isDraft}
            id={id}
            connectionMode={connectionMode}
            c={c}
            resolveModelLabel={resolveModelLabel}
            onClose={onClose}
            onResetHistory={handleResetHistory}
          />
        )}

        <MessageListBody
          scroll={scroll}
          c={c}
          fullscreenChat={fullscreenChat}
          isWelcomeDraft={session.is_welcome_draft}
          header={<ContextOverflowCard session={session} id={id} workflowEditId={workflowEditId} c={c} />}
          footer={
            <TranscriptFooter
              vm={{
                session, id, c, mcpActivation, isDraft, welcomeGreetingDone,
                preSendActivityLabel, awaitingResponse, streamingMessageId,
                showResumeBubble, isWorkflowRunSidecar, readOnly, fullscreenChat,
                fallbackBrowserSlot: browserAnchorItemId ? null : browserSlot,
                onPickQuickReply: (p) => handleSend(p),
                onPickBuilder: (p) => chatInputRef.current?.setContent(p),
                onResume: handleResume,
                onStreamGrew: stickToBottomIfNeeded,
              }}
            />
          }
          renderItem={(item, { isLastVisibleItem }) => <TranscriptItem item={item} vm={itemVm} isLastVisibleItem={isLastVisibleItem} />}
          // The live browser anchors AT the browser tool row (ChatGPT-agent model): the view sits where the work happened, above the answer that follows it.
          renderItemTrailer={(item) => (browserAnchorItemId && item.id === browserAnchorItemId ? browserSlot : null)}
        />

        <PendingApprovalBars requests={session.pending_approvals} />

        <RateLimitPill sessionId={session.id} />
        <ProviderRetryPill sessionId={session.id} />
        <ContextRecoveredPill sessionId={session.id} />

        {isGlowing ? (
          <ContinueChatGlow onDismissGlow={onDismissGlow} c={c} />
        ) : (
          <ClickAwayListener onClickAway={() => { if (queue.expanded) { queue.setExpanded(false); queue.setEditingIdx(null); } }}>
            <Box>
              <QueuePanel queue={queue} c={c} />
              <HaikuMcpWarning model={model} c={c} />
              <McpSuggestionsBanner session={session} id={id} c={c} mcpActivation={mcpActivation} />
              {readOnly ? null : isStoppableSidecar ? (
                <ForceStopAgentBar onStop={handleStop} onSaveWorkflow={onTestSaveWorkflow} onContinueEditing={onTestContinueEditing} testState={testState} />
              ) : (
                <Box sx={{ position: 'relative' }}>
                  <WorkflowModelNotice c={c} label={workflowNotice} />
                  <FreeTrialModelNotice c={c} notice={freeTrialNotice} />
                  <FollowupChips
                    sessionId={id}
                    busy={agentBusy}
                    messageCount={session?.messages?.length ?? 0}
                    enabled={!isDraft && !readOnly && !runContext}
                    onPick={(p) => handleSend(p)}
                  />
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
                    queueLength={queue.length}
                    contextEstimate={contextEstimate}
                    sessionId={id}
                    autoFocus={autoFocus}
                    prefillPrompt={prefillPrompt}
                    placeholderOverride={runContext ? 'Ask about this run...' : embedded ? composerPlaceholder(session.id, (session.messages || []).some((mm) => mm.role === 'assistant')) : undefined}
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

export default AgentChat;
