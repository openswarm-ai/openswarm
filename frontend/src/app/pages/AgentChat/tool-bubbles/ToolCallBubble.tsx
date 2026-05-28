import React, { useState, useCallback, useMemo, useRef } from 'react';
import { AgentMessage, expandSession, collapseSession, fetchSession } from '@/shared/state/agentsSlice';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { placeCard, removeCard, setGlowingAgentCard, clearGlowingAgentCard, DEFAULT_CARD_W, DEFAULT_CARD_H, EXPANDED_CARD_MIN_H, GRID_GAP } from '@/shared/state/dashboardLayoutSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
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

export { parseMcpToolName, getMcpShortAction } from '@/shared/mcpToolMeta';
export type { McpToolInfo } from '@/shared/mcpToolMeta';

export interface ToolPair {
  type: 'tool_pair';
  id: string;
  call: AgentMessage;
  result: AgentMessage | null;
}

interface ToolCallBubbleProps {
  call: AgentMessage;
  result?: AgentMessage | null;
  isPending?: boolean;
  isStreaming?: boolean;
  mcpCompact?: boolean;
  sessionId?: string;
}

const ToolCallBubble: React.FC<ToolCallBubbleProps> = React.memo(
  ({ call, result = null, isPending = false, isStreaming = false, mcpCompact = false, sessionId }) => {
    ensureToolCallKeyframes();

    const c = useClaudeTokens();
    const dispatch = useAppDispatch();
    const cards = useAppSelector((s) => s.dashboardLayout.cards);
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
    const showBody = expanded || isStreaming || browserAgentAutoExpand;

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

    const sessions = useAppSelector((s) => s.agents.sessions);
    const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);

    const handleRevealAgent = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!revealTargetSessionId || !sessionId) return;

        if (cards[revealTargetSessionId]) {
          dispatch(collapseSession(revealTargetSessionId));
          dispatch(removeCard(revealTargetSessionId));
          setTimeout(() => {
            dispatch(clearGlowingAgentCard(revealTargetSessionId));
          }, 500);
          return;
        }

        let sourceYRatio: number | undefined;
        if (bubbleRef.current) {
          const bubbleEl = bubbleRef.current;
          const cardEl = bubbleEl.closest('[data-select-type="agent-card"]') as HTMLElement | null;
          if (cardEl) {
            const cardRect = cardEl.getBoundingClientRect();
            const bubbleRect = bubbleEl.getBoundingClientRect();
            const bubbleCenterY = bubbleRect.top + bubbleRect.height / 2;
            const ratio = (bubbleCenterY - cardRect.top) / cardRect.height;
            sourceYRatio = Math.max(0, Math.min(1, ratio));
          }
        }

        const doPlace = () => {
          const parentCard = cards[sessionId];
          const targetX = parentCard
            ? parentCard.x + parentCard.width + GRID_GAP * 12
            : 40;
          let targetY = parentCard ? parentCard.y : 100;
          if (parentCard) {
            const columnCards = Object.values(cards).filter(
              (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== revealTargetSessionId,
            );
            if (columnCards.length > 0) {
              const lowestBottom = Math.max(
                ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
              );
              targetY = lowestBottom + GRID_GAP;
            }
          }
          dispatch(placeCard({
            sessionId: revealTargetSessionId,
            x: targetX,
            y: targetY,
            width: DEFAULT_CARD_W,
            height: DEFAULT_CARD_H,
            expandedSessionIds,
          }));
          dispatch(expandSession(revealTargetSessionId));
          const label = isCreateAgent ? 'Create Agent' : isInvokeAgent ? 'Invoke Agent' : 'Agent';
          dispatch(setGlowingAgentCard({ sessionId: revealTargetSessionId, sourceId: sessionId, sourceYRatio, label }));
        };

        if (!sessions[revealTargetSessionId]) {
          dispatch(fetchSession(revealTargetSessionId)).then(doPlace);
        } else {
          doPlace();
        }
      },
      [revealTargetSessionId, sessionId, cards, sessions, dispatch],
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

    const selectAttrs = {
      'data-select-type': 'tool-call' as const,
      'data-select-id': call.id,
      'data-select-meta': JSON.stringify({ tool: toolName, inputSummary }),
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
      />
    );
  }
);

export default ToolCallBubble;
