import React, { useState, useCallback, useMemo, useRef } from 'react';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { revealSubAgent } from './revealSubAgent';
import { ensureToolCallKeyframes } from '../parsing/toolBubbleChrome';
import {
  getToolData,
  getInputSummary,
  formatInputDisplay,
  parseToolResult,
  getResultSummary,
  getPromptPrefix,
} from '../parsing/toolResultParsing';
import { parseMcpToolName } from '@/shared/mcpToolMeta';
import {
  isBrowserAgentTool,
  isInvokeAgentTool,
  isCreateAgentTool,
  parseInvokedSessionId,
  parseCreateAgentResult,
  parseInvokeAgentResult,
} from '../parsing/agentToolParsing';
import { InvokeAgentBubble } from './InvokeAgentBubble';
import { CreateAgentBubble } from './CreateAgentBubble';
import { CompactMcpBubble } from './CompactMcpBubble';
import { DefaultToolBubble } from './DefaultToolBubble';
import { openCardContextMenu, isNativeMenuTarget, type CardMenuRow } from '../../Dashboard/desktop/openCardContextMenu';

export { parseMcpToolName, getMcpShortAction } from '@/shared/mcpToolMeta';
export type { McpToolInfo } from '@/shared/mcpToolMeta';

export interface ToolPair {
  type: 'tool_pair';
  id: string;
  call: AgentMessage;
  result: AgentMessage | null;
}

/** Spread onto every bubble variant's root: the select-frame data attrs plus the shared right-click menu. */
export interface ToolSelectAttrs {
  'data-select-type': 'tool-call';
  'data-select-id': string;
  'data-select-meta': string;
  onContextMenu: (e: React.MouseEvent) => void;
}

interface ToolCallBubbleProps {
  call: AgentMessage;
  result?: AgentMessage | null;
  isPending?: boolean;
  isStreaming?: boolean;
  mcpCompact?: boolean;
  sessionId?: string;
  suppressReveal?: boolean;
}

const ToolCallBubble: React.FC<ToolCallBubbleProps> = React.memo(
  ({ call, result = null, isPending = false, isStreaming = false, mcpCompact = false, sessionId, suppressReveal = false }) => {
    ensureToolCallKeyframes();

    const c = useClaudeTokens();
    const dispatch = useAppDispatch();
    const [expanded, setExpanded] = useState(false);
    const bubbleRef = useRef<HTMLDivElement>(null);

    const { toolName, input, isDenied } = getToolData(call);
    const mcpInfo = useMemo(() => parseMcpToolName(toolName), [toolName]);
    const inputSummary = getInputSummary(toolName, input);
    const formattedInput = useMemo(() => formatInputDisplay(toolName, input), [toolName, input]);
    const showTimer = isPending && !isDenied && !isStreaming;

    const isBrowserAgent = isBrowserAgentTool(toolName);
    const isInvokeAgent = isInvokeAgentTool(toolName);
    const isCreateAgent = isCreateAgentTool(toolName);
    const browserAgentAutoExpand = isBrowserAgent && isPending && !isStreaming;
    // While the call is still streaming we keep the body CLOSED: the args land in bursty clumps and force-painting them mid-stream is the jitter the user feels. The header pill (tool name + glow) is the calm "what's running" signal; the full args/output live behind the chevron once the call lands and is expanded.
    const showBody = expanded || browserAgentAutoExpand;

    const resultContent = result?.content;
    const hasStructuredResult =
      resultContent && typeof resultContent === 'object' && 'text' in resultContent;
    const resultRawText: string = hasStructuredResult
      ? resultContent.text
      : typeof resultContent === 'string'
        ? resultContent
        : resultContent
          ? JSON.stringify(resultContent, null, 2)
          : '';
    const resultElapsedMs: number | null = hasStructuredResult
      ? resultContent.elapsed_ms ?? null
      : null;

    const parsedResult = useMemo(
      () => (result ? parseToolResult(toolName, resultRawText) : null),
      [result, toolName, resultRawText],
    );
    const resultSummary = result ? getResultSummary(toolName, resultRawText) : null;
    const isError =
      resultSummary?.startsWith('✗') ||
      (parsedResult?.type === 'bash' && parsedResult.exitCode !== null && parsedResult.exitCode !== 0) ||
      (parsedResult?.type === 'text' && parsedResult.isError);

    const invokedSessionId = useMemo(
      () => (isInvokeAgent && result ? parseInvokedSessionId(resultRawText) : null),
      [isInvokeAgent, result, resultRawText],
    );
    const invokeAgentParsed = useMemo(
      () => (isInvokeAgent && result ? parseInvokeAgentResult(resultRawText) : null),
      [isInvokeAgent, result, resultRawText],
    );
    const createAgentResponse = useMemo(
      () => (isCreateAgent && result ? parseCreateAgentResult(resultRawText) : ''),
      [isCreateAgent, result, resultRawText],
    );
    const createAgentSessionId: string | null = useMemo(
      () => (isCreateAgent && hasStructuredResult && resultContent?.sub_session_id) ? resultContent.sub_session_id : null,
      [isCreateAgent, hasStructuredResult, resultContent],
    );

    const revealTargetSessionId = invokedSessionId || createAgentSessionId;

    const handleRevealAgent = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!revealTargetSessionId || !sessionId) return;
        const label = isCreateAgent ? 'Create Agent' : isInvokeAgent ? 'Invoke Agent' : 'Agent';
        revealSubAgent(dispatch, sessionId, revealTargetSessionId, bubbleRef.current, label);
      },
      [revealTargetSessionId, sessionId, dispatch, isCreateAgent, isInvokeAgent],
    );

    const toggle = useCallback(() => {
      if (!isStreaming) setExpanded((v) => !v);
    }, [isStreaming]);

    const accentRgb = c.accent.primary
      .replace('#', '')
      .match(/.{2}/g)
      ?.map((h) => parseInt(h, 16))
      .join(', ') || '189, 100, 57';

    const promptPrefix = getPromptPrefix(toolName);

    // ENG-148: tool rows answer right-click with the shared grammar (copy the command/output, toggle details) instead of falling through to the OS text menu.
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      if (isNativeMenuTarget(e)) return;
      const selection = window.getSelection()?.toString() ?? '';
      const inputText = formattedInput || inputSummary || JSON.stringify(input, null, 2);
      const items: CardMenuRow[] = [{ kind: 'header', label: mcpInfo.isMcp ? mcpInfo.displayName : toolName }];
      if (selection) items.push({ label: 'Copy selection', onClick: () => { void navigator.clipboard.writeText(selection); } });
      items.push({ label: toolName === 'Bash' ? 'Copy command' : 'Copy input', disabled: !inputText, onClick: () => { void navigator.clipboard.writeText(inputText); } });
      items.push({ label: 'Copy output', disabled: !resultRawText, onClick: () => { void navigator.clipboard.writeText(resultRawText); } });
      items.push({ kind: 'separator' });
      items.push({ label: expanded ? 'Collapse details' : 'Expand details', disabled: isStreaming, onClick: toggle });
      openCardContextMenu(e, { items });
    }, [formattedInput, inputSummary, input, mcpInfo, toolName, resultRawText, expanded, isStreaming, toggle]);

    const selectAttrs: ToolSelectAttrs = {
      'data-select-type': 'tool-call' as const,
      'data-select-id': call.id,
      'data-select-meta': JSON.stringify({ tool: toolName, inputSummary }),
      onContextMenu: handleContextMenu,
    };

    if (isInvokeAgent) {
      return (
        <InvokeAgentBubble
          call={call}
          input={input}
          isPending={isPending}
          isDenied={isDenied}
          isError={!!isError}
          resultElapsedMs={resultElapsedMs}
          expanded={expanded}
          showTimer={showTimer}
          toggle={toggle}
          accentRgb={accentRgb}
          invokeAgentParsed={invokeAgentParsed}
          invokedSessionId={invokedSessionId}
          handleRevealAgent={handleRevealAgent}
          bubbleRef={bubbleRef}
          selectAttrs={selectAttrs}
        />
      );
    }

    if (isCreateAgent) {
      return (
        <CreateAgentBubble
          call={call}
          input={input}
          isPending={isPending}
          isDenied={isDenied}
          isError={!!isError}
          resultElapsedMs={resultElapsedMs}
          expanded={expanded}
          showTimer={showTimer}
          toggle={toggle}
          accentRgb={accentRgb}
          createAgentResponse={createAgentResponse}
          createAgentSessionId={createAgentSessionId}
          handleRevealAgent={handleRevealAgent}
          bubbleRef={bubbleRef}
          selectAttrs={selectAttrs}
        />
      );
    }

    if (mcpCompact && mcpInfo.isMcp) {
      return (
        <CompactMcpBubble
          call={call}
          input={input}
          sessionId={sessionId}
          isPending={isPending}
          isStreaming={isStreaming}
          isDenied={isDenied}
          isError={!!isError}
          result={result}
          mcpInfo={mcpInfo}
          toolName={toolName}
          resultSummary={resultSummary}
          resultElapsedMs={resultElapsedMs}
          showTimer={showTimer}
          showBody={showBody}
          toggle={toggle}
          parsedResult={parsedResult}
          isBrowserAgent={isBrowserAgent}
          selectAttrs={selectAttrs}
        />
      );
    }

    return (
      <DefaultToolBubble
        call={call}
        input={input}
        sessionId={sessionId}
        mcpCompact={mcpCompact}
        isPending={isPending}
        isStreaming={isStreaming}
        isDenied={isDenied}
        isError={!!isError}
        result={result}
        mcpInfo={mcpInfo}
        toolName={toolName}
        inputSummary={inputSummary}
        formattedInput={formattedInput}
        promptPrefix={promptPrefix}
        resultSummary={resultSummary}
        resultElapsedMs={resultElapsedMs}
        showTimer={showTimer}
        showBody={showBody}
        toggle={toggle}
        parsedResult={parsedResult}
        isBrowserAgent={isBrowserAgent}
        accentRgb={accentRgb}
        selectAttrs={selectAttrs}
        suppressReveal={suppressReveal}
      />
    );
  }
);

export default ToolCallBubble;
