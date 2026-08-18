import { useCallback, useMemo } from 'react';
import { useAppSelector } from '@/shared/hooks';
import type { AgentMessage, AgentSession } from '@/shared/state/agentsSlice';
import { type RenderItem, isToolGroup, isToolPair } from '../tool-bubbles/ToolGroupBubble';
import { extractPendingAskUi } from '../tool-ui/showUiPayload';
import { stringifyContent } from '../windowing/messageWindow';
import { buildRenderItems } from './buildRenderItems';

const CONTEXT_WINDOWS: Record<string, number> = {
  'opus-4-8': 1_000_000,
  'opus-4-7': 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
};

// Pure derivations from the session transcript (AGENTCHAT_SPLIT_PLAN follow-up): the active-branch
// message slice, the grouped render items the windowing layer consumes (buildRenderItems), the per-turn
// last-assistant set, the latest live AskUI id, the context gauge estimate, and the sibling-branch
// resolver. All memos/callbacks, no effects — lifted verbatim from AgentChat.
export function useTranscriptDerivations({
  session,
  model,
  streamingMessageId,
  sessionRunning,
}: {
  session: AgentSession | undefined;
  model: string;
  streamingMessageId: string | null;
  sessionRunning: boolean;
}) {
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);

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

  const renderItems: RenderItem[] = useMemo(
    () => buildRenderItems(activeBranchMessages, sessionRunning),
    [activeBranchMessages, sessionRunning],
  );

  const lastPendingAskCallId = useMemo(
    () => extractPendingAskUi(session?.messages || [])?.call.id ?? null,
    [session?.messages],
  );

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

  return { activeBranchMessages, renderItems, lastAssistantIdsInTurn, lastPendingAskCallId, contextEstimate, getSiblingBranches };
}
