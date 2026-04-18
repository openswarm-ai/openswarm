import React, { useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { AssistantRuntimeProvider, useAui, Tools } from '@assistant-ui/react';
import { ApprovalRouter, BatchApprovalWrapper } from './toolkit/approval-tools';
import ChatHeader from './ChatHeader';
import MessageQueue from './MessageQueue';
import OpenSwarmThread from './OpenSwarmThread/OpenSwarmThread';
import ChatInput from './ChatInput/ChatInput';
import { useAgentChat } from './hooks/useAgentChat';
import { useOpenSwarmRuntime, type ComposerExtras, type DispatchableMessage } from './runtime/useOpenSwarmRuntime';
import { toolkit } from './toolkit';
import type { ContextPath } from '@/shared/state/agentsTypes';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

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

const AgentChat: React.FC<AgentChatProps> = ({ sessionId, onClose, embedded, autoFocus, isGlowing, onDismissGlow, initialContextPaths, onBranch }) => {
  const c = useClaudeTokens();
  const {
    id, session, isDraft, mode, model,
    messageQueueRef, showResumeBubble,
    queueLength, setQueueLength, agentBusy,
    handleSend, handleModeChange, handleModelChange,
    handleApprove, handleDeny, handleStop, handleResume,
  } = useAgentChat({ sessionId });

  const composerExtrasRef = useRef<ComposerExtras>({});
  const dispatchForRuntime = useCallback((msg: DispatchableMessage) => {
    handleSend(msg.prompt, msg.images, msg.contextPaths, msg.forcedTools, msg.attachedSkills, msg.selectedBrowserIds);
  }, [handleSend]);

  const runtime = useOpenSwarmRuntime(id, {
    composerExtrasRef,
    dispatchMessage: dispatchForRuntime,
  });
  const aui = useAui({ tools: Tools({ toolkit }) });

  const contextEstimate = { used: 0, limit: 200_000 };

  if (!session) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2 }}>
        <Typography sx={{ color: c.text.tertiary, fontSize: '1rem' }}>Session not found</Typography>
      </Box>
    );
  }
  return (
    <AssistantRuntimeProvider runtime={runtime} aui={aui}>
    <Box sx={{ display: 'flex', height: '100%' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {!embedded && <ChatHeader session={session} isDraft={isDraft} id={id} onClose={onClose} />}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <OpenSwarmThread sessionId={id} onBranchChat={onBranch} />
        </Box>

        {session.pending_approvals.length > 1 ? (
          <BatchApprovalWrapper requests={session.pending_approvals} onApprove={handleApprove} onDeny={handleDeny} />
        ) : (
          session.pending_approvals.map((req) => (
            <ApprovalRouter key={req.id} request={req} onApprove={handleApprove} onDeny={handleDeny} />
          ))
        )}

        {showResumeBubble && session.status === 'stopped' && (
          <Box
            onClick={handleResume}
            sx={{
              mx: 1.5, mb: 1.5, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 2.5, cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
              color: c.accent.primary, border: `1.5px solid ${c.accent.primary}`,
              background: `${c.accent.primary}08`,
              transition: 'background 0.15s, box-shadow 0.15s',
              '&:hover': { background: `${c.accent.primary}14` },
            }}
          >
            Resume
          </Box>
        )}

        {isGlowing ? (
          <Box
            onClick={(e) => { e.stopPropagation(); onDismissGlow?.(); }}
            sx={{
              mx: 1.5, mb: 1.5, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 2.5, cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
              color: c.accent.primary, border: `1.5px solid ${c.accent.primary}`,
              background: `${c.accent.primary}08`,
              boxShadow: `0 0 12px ${c.accent.primary}25, inset 0 0 12px ${c.accent.primary}08`,
              animation: 'continue-chat-glow 2s ease-in-out infinite',
              transition: 'background 0.15s, box-shadow 0.15s',
              '@keyframes continue-chat-glow': {
                '0%, 100%': { boxShadow: `0 0 12px ${c.accent.primary}25, inset 0 0 12px ${c.accent.primary}08` },
                '50%': { boxShadow: `0 0 20px ${c.accent.primary}40, inset 0 0 20px ${c.accent.primary}15` },
              },
              '&:hover': { background: `${c.accent.primary}14`, boxShadow: `0 0 24px ${c.accent.primary}50, inset 0 0 20px ${c.accent.primary}18` },
            }}
          >
            Continue chat
          </Box>
        ) : (
          <MessageQueue messageQueueRef={messageQueueRef} queueLength={queueLength} setQueueLength={setQueueLength}>
            <ChatInput
              composerExtrasRef={composerExtrasRef}
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
              initialContextPaths={initialContextPaths}
            />
          </MessageQueue>
        )}
      </Box>
    </Box>
    </AssistantRuntimeProvider>
  );
};

export default AgentChat;
