import React, { useEffect, useRef } from 'react';
import { useStreamingMessage } from '@/shared/state/streamingSlice';
import MessageBubble from './MessageBubble';
import ToolCallBubble from './ToolCallBubble';

interface Props {
  sessionId: string;
  activeBranchId: string;
  turnLabel?: string | null;
  onStreamGrew?: () => void;
}

/** Leaf subscriber for one session's streaming entry; isolates re-renders so AgentChat doesn't churn per character. */
const StreamingBubble: React.FC<Props> = ({ sessionId, activeBranchId, turnLabel, onStreamGrew }) => {
  const streamingMessage = useStreamingMessage(sessionId);
  const typedContent = streamingMessage?.content ?? '';
  // RAF-coalesce so onStreamGrew fires once per frame regardless of token rate.
  const onGrewRef = useRef(onStreamGrew);
  onGrewRef.current = onStreamGrew;
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!streamingMessage) return;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      onGrewRef.current?.();
    });
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  });
  if (!streamingMessage) return null;

  if (streamingMessage.role === 'tool_call') {
    return (
      <ToolCallBubble
        key={`streaming-${streamingMessage.id}`}
        isStreaming
        isPending
        sessionId={sessionId}
        call={{
          id: streamingMessage.id,
          role: 'tool_call',
          content: { tool: streamingMessage.tool_name || '', input: typedContent },
          timestamp: new Date().toISOString(),
          branch_id: activeBranchId,
          parent_id: null,
        }}
      />
    );
  }

  return (
    <MessageBubble
      key={`streaming-${streamingMessage.id}`}
      isStreaming
      dynamicTurnLabel={turnLabel}
      message={{
        id: streamingMessage.id,
        role: streamingMessage.role,
        content: typedContent,
        timestamp: new Date().toISOString(),
        branch_id: activeBranchId,
        parent_id: null,
      }}
    />
  );
};

export default StreamingBubble;
