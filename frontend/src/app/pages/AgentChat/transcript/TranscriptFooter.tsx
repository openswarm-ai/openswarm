import Box from '@mui/material/Box';
import { useAppDispatch } from '@/shared/hooks';
import { clearMcpSuggestions, type AgentSession } from '@/shared/state/agentsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type React from 'react';
import StreamingBubble from '../bubbles/StreamingBubble';
import WelcomeQuickReplies from '../WelcomeQuickReplies';
import InlineSurfaceEmbeds from '../shell/InlineSurfaceEmbeds';
import { ThinkingBubble } from '../streaming/ThinkingBubble';
import { McpConnectOffer } from '../render/McpConnectOffer';
import { ResumeAgentButton } from '../render/ResumeAgentButton';
import type { useMcpActivation } from '../model/useMcpActivation';

// Everything the below-the-items transcript tail needs, as one structured view model built fresh each
// render by AgentChat (same staleness semantics as the previously-inline JSX).
export interface TranscriptFooterVm {
  session: AgentSession;
  id: string | undefined;
  c: ReturnType<typeof useClaudeTokens>;
  mcpActivation: ReturnType<typeof useMcpActivation>;
  isDraft: boolean;
  welcomeGreetingDone: boolean;
  preSendActivityLabel: string | null;
  awaitingResponse: boolean;
  streamingMessageId: string | null;
  showResumeBubble: boolean;
  isWorkflowRunSidecar: boolean;
  readOnly: boolean | undefined;
  fullscreenChat: boolean | undefined;
  // The docked-surface slot when no browser tool row anchors it yet (useDockedBrowserSlot); null otherwise.
  fallbackBrowserSlot: React.ReactNode;
  onPickQuickReply: (prompt: string) => void;
  onPickBuilder: (prompt: string) => void;
  onResume: () => void;
  onStreamGrew: () => void;
}

// The non-windowed tail of the transcript: live stream bubble, MCP connect offer, the agent's live
// surfaces, first-run welcome chips, thinking dots, the resume pill, and the fallback dock slot. Lifted
// verbatim from AgentChat's render; sits inside the MessageListBody footer slot, below the bottom spacer.
export function TranscriptFooter({ vm }: { vm: TranscriptFooterVm }) {
  const { session, id, c, mcpActivation } = vm;
  const dispatch = useAppDispatch();
  return (
    <>
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
            onStreamGrew={vm.onStreamGrew}
          />
        </Box>
      )}
      {/* Connect offer sits BELOW the latest reply (where the eye is), not at the top of the
          transcript where the auto-scroll-to-bottom buries it. Suggest-only; activation is the
          user's click through the gated MCPActivate endpoint. */}
      {(session.mcp_suggestions && session.mcp_suggestions.length > 0) && (
        <McpConnectOffer
          suggestions={session.mcp_suggestions}
          activatingId={mcpActivation.activatingId}
          error={mcpActivation.error}
          onActivate={(s) => mcpActivation.activate(s, session.id)}
          onDismiss={() => id && dispatch(clearMcpSuggestions({ sessionId: id }))}
          c={c}
        />
      )}
      {/* The surfaces this agent is driving, live inside the chat: browser snapshots + built
          apps, each one click from popping out onto the canvas. */}
      {!vm.isDraft && id && <InlineSurfaceEmbeds c={c} sessionId={id} fullscreen={vm.fullscreenChat} />}
      {/* First-run welcome chips: sit UNDER the streamed greeting, appear once it finishes,
          vanish the moment the user answers. The greeting itself is a real assistant bubble. */}
      {session.is_welcome_draft && vm.isDraft && vm.welcomeGreetingDone && !session.messages.some((m) => m.role === 'user') && (
        <WelcomeQuickReplies
          c={c}
          onPick={vm.onPickQuickReply}
          onPickBuilder={vm.onPickBuilder}
        />
      )}
      {(vm.preSendActivityLabel || vm.awaitingResponse || (session.status === 'running' && !vm.streamingMessageId)) && (
        <Box sx={{ overflowAnchor: 'none' }}>
          <ThinkingBubble label={vm.preSendActivityLabel || session.turn_label?.label} />
        </Box>
      )}
      {vm.showResumeBubble && session.status === 'stopped' && !vm.isWorkflowRunSidecar && !vm.readOnly && (
        <ResumeAgentButton onResume={vm.onResume} c={c} />
      )}
      {/* Fallback dock slot for a browser that docked before any browser tool row exists (or whose row was compacted away); once a row appears the slot anchors at it instead (see browserAnchorItemId). */}
      {vm.fallbackBrowserSlot}
    </>
  );
}
