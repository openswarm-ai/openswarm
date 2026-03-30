import { useCallback, useMemo, type MutableRefObject } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  sendMessage as sendMessageThunk,
  editMessage,
  stopAgent,
  type AgentMessage,
  type StreamingMessage,
} from '@/shared/state/agentsSlice';

export interface ComposerExtras {
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  selectedBrowserIds?: string[];
}

export interface DispatchableMessage {
  prompt: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  selectedBrowserIds?: string[];
}

export interface RuntimeOptions {
  composerExtrasRef?: MutableRefObject<ComposerExtras>;
  dispatchMessage?: (msg: DispatchableMessage) => void;
}

type RawMessage = AgentMessage | (StreamingMessage & { _streaming: true });

function convertMessage(msg: RawMessage): ThreadMessageLike {
  if ('_streaming' in msg) {
    const streaming = msg as StreamingMessage & { _streaming: true };
    if (streaming.role === 'tool_call') {
      return {
        role: 'assistant',
        id: streaming.id,
        content: [
          {
            type: 'tool-call',
            toolCallId: streaming.id,
            toolName: streaming.tool_name || 'unknown',
            args: {},
          },
        ],
        status: { type: 'running' },
      };
    }
    return {
      role: 'assistant',
      id: streaming.id,
      content: [{ type: 'text', text: streaming.content }],
      status: { type: 'running' },
    };
  }

  const createdAt = msg.timestamp ? new Date(msg.timestamp) : undefined;
  const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

  switch (msg.role) {
    case 'user':
      return { role: 'user', id: msg.id, createdAt, content: [{ type: 'text', text }] };

    case 'assistant':
      return { role: 'assistant', id: msg.id, createdAt, content: [{ type: 'text', text }] };

    case 'tool_call': {
      const content = typeof msg.content === 'object' && msg.content !== null ? msg.content : {};
      return {
        role: 'assistant',
        id: msg.id,
        createdAt,
        content: [
          {
            type: 'tool-call',
            toolCallId: msg.id,
            toolName: content.tool || content.name || 'unknown',
            args: content.input ?? content.args ?? content,
          },
        ],
      };
    }

    case 'tool_result': {
      const content = typeof msg.content === 'object' && msg.content !== null ? msg.content : {};
      const parentToolCallId = msg.parent_id || msg.id;
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: parentToolCallId,
            result: content.output ?? content.result ?? content,
          },
        ],
      };
    }

    case 'system':
      return { role: 'system', id: msg.id, content: [{ type: 'text', text }] };

    default:
      return { role: 'system', id: msg.id, content: [{ type: 'text', text: '' }] };
  }
}

function extractText(message: AppendMessage): string {
  for (const part of message.content) {
    if (part.type === 'text') return part.text;
  }
  return '';
}

export function useOpenSwarmRuntime(
  sessionId: string | undefined,
  options?: RuntimeOptions,
) {
  const dispatch = useAppDispatch();
  const session = useAppSelector((state) =>
    sessionId ? state.agents.sessions[sessionId] : undefined,
  );

  const rawMessages = useMemo<RawMessage[]>(() => {
    if (!session) return [];
    const msgs: RawMessage[] = session.messages.filter((m) => !m.hidden);
    if (session.streamingMessage) {
      msgs.push({ ...session.streamingMessage, _streaming: true as const });
    }
    return msgs;
  }, [session]);

  const isRunning = session?.status === 'running';

  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (!sessionId) return;
      const text = extractText(message);
      if (!text) return;

      if (options?.dispatchMessage) {
        const extras = options.composerExtrasRef?.current ?? {};
        if (options.composerExtrasRef) {
          options.composerExtrasRef.current = {};
        }
        options.dispatchMessage({ prompt: text, ...extras });
      } else {
        dispatch(sendMessageThunk({ sessionId, prompt: text }));
      }
    },
    [sessionId, dispatch, options],
  );

  const onEdit = useCallback(
    async (message: AppendMessage) => {
      if (!sessionId || !message.parentId) return;
      const text = extractText(message);
      dispatch(editMessage({ sessionId, messageId: message.parentId, content: text }));
    },
    [sessionId, dispatch],
  );

  const onCancel = useCallback(async () => {
    if (!sessionId) return;
    dispatch(stopAgent({ sessionId }));
  }, [sessionId, dispatch]);

  const runtime = useExternalStoreRuntime({
    messages: rawMessages,
    convertMessage,
    isRunning,
    onNew,
    onEdit,
    onCancel,
  });

  return runtime;
}
