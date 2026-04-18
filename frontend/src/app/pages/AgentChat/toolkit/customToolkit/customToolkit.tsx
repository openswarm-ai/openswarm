import React from 'react';
import type { ReactNode } from 'react';
import type { Toolkit } from '@assistant-ui/react';
import { InvokeAgentBubble, CreateAgentBubble } from './components/AgentToolBubble';
import ViewBubble from './components/ViewBubble';

// ---------------------------------------------------------------------------
// Render-props contract (mirrors native-tools.tsx pattern)
// ---------------------------------------------------------------------------

interface RP {
  args: unknown;
  result: unknown;
  status: { type: string };
  toolCallId: string;
}

type BE = { type: 'backend'; render: (p: RP) => ReactNode };
const be = (render: (p: RP) => ReactNode): BE => ({ type: 'backend', render });

// ---------------------------------------------------------------------------
// Prop bridges — ToolCallMessagePartProps → legacy component interfaces
// ---------------------------------------------------------------------------

function bridgeToCallMessage(
  toolCallId: string,
  toolName: string,
  args: unknown,
) {
  return {
    id: toolCallId,
    role: 'tool_call' as const,
    content: { tool: toolName, input: args || {}, id: toolCallId },
    timestamp: Date.now(),
  };
}

function bridgeToResultMessage(toolCallId: string, result: unknown) {
  if (result == null) return null;
  let text: string;
  if (typeof result === 'string') {
    text = result;
  } else if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    text =
      typeof r.text === 'string'
        ? r.text
        : typeof r.content === 'string'
          ? r.content
          : JSON.stringify(result);
  } else {
    text = String(result);
  }
  return {
    id: `${toolCallId}-result`,
    role: 'tool_result' as const,
    content: { text },
  };
}

// ---------------------------------------------------------------------------
// InvokeAgent
// ---------------------------------------------------------------------------

const invokeAgentRenderer = be(({ args, result, status, toolCallId }) => {
  const call = bridgeToCallMessage(toolCallId, 'InvokeAgent', args);
  const resultMsg =
    status.type !== 'running' && result != null
      ? bridgeToResultMessage(toolCallId, result)
      : null;

  return (
    <InvokeAgentBubble
      call={call as any}
      result={resultMsg as any}
      isPending={status.type === 'running'}
      isStreaming={false}
    />
  );
});

// ---------------------------------------------------------------------------
// CreateAgent (tool name "Agent")
// ---------------------------------------------------------------------------

const createAgentRenderer = be(({ args, result, status, toolCallId }) => {
  const call = bridgeToCallMessage(toolCallId, 'Agent', args);
  const resultMsg =
    status.type !== 'running' && result != null
      ? bridgeToResultMessage(toolCallId, result)
      : null;

  return (
    <CreateAgentBubble
      call={call as any}
      result={resultMsg as any}
      isPending={status.type === 'running'}
      isStreaming={false}
    />
  );
});

// ---------------------------------------------------------------------------
// RenderOutput → ViewBubble
// ---------------------------------------------------------------------------

const renderOutputRenderer = be(({ args, result, status }) => {
  const toolInput =
    typeof args === 'object' && args !== null
      ? (args as Record<string, any>)
      : {};
  const toolResult = result as string | Record<string, any> | undefined;

  return (
    <ViewBubble
      toolInput={toolInput}
      toolResult={toolResult}
      isStreaming={status.type === 'running'}
    />
  );
});

// ---------------------------------------------------------------------------
// Exported toolkit
// ---------------------------------------------------------------------------

export const customToolkit: Partial<Toolkit> = {
  InvokeAgent: invokeAgentRenderer,
  Agent: createAgentRenderer,
  RenderOutput: renderOutputRenderer,
} as Partial<Toolkit>;
