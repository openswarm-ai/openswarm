import React, { useState, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import TerminalIcon from '@mui/icons-material/Terminal';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import SearchIcon from '@mui/icons-material/Search';
import GoogleServiceIcon from '@/app/components/GoogleServiceIcon';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useTermColors, colorizeInput, colorizeOutput } from './toolCallColors';
import { ElapsedTimer } from './ElapsedTimer';
import { BrowserFeedTracker, renderParsedMcpData } from './toolkit/mcp-tools';
import { InvokeAgentBubble, CreateAgentBubble } from './AgentToolBubble';
import {
  ToolCallBubbleProps, ensureToolCallKeyframes, getToolData, parseMcpToolName,
  getMcpShortAction, getInputSummary, formatInputDisplay, parseToolResult,
  getResultSummary, getPromptPrefix, formatElapsed,
  isBrowserAgentTool, isInvokeAgentTool, isCreateAgentTool,
} from './toolCallUtils';

export { parseMcpToolName, getMcpShortAction, getResultSummary } from './toolCallUtils';
export type { ToolPair, McpToolInfo } from './toolCallUtils';

const ToolCallBubble: React.FC<ToolCallBubbleProps> = React.memo(
  ({ call, result = null, isPending = false, isStreaming = false, mcpCompact = false, sessionId }) => {
    ensureToolCallKeyframes();
    const c = useClaudeTokens();
    const tc = useTermColors();
    const [expanded, setExpanded] = useState(false);
    const { toolName, input, isDenied } = getToolData(call);
    const mcpInfo = useMemo(() => parseMcpToolName(toolName), [toolName]);
    const inputSummary = getInputSummary(toolName, input);
    const formattedInput = useMemo(() => formatInputDisplay(toolName, input), [toolName, input]);
    const showTimer = isPending && !isDenied && !isStreaming;
    const isBrowserAgent = isBrowserAgentTool(toolName);
    const browserAgentAutoExpand = isBrowserAgent && isPending && !isStreaming;
    const showBody = expanded || isStreaming || browserAgentAutoExpand;
    const resultContent = result?.content;
    const hasStructuredResult = resultContent && typeof resultContent === 'object' && 'text' in resultContent;
    const resultRawText: string = hasStructuredResult ? resultContent.text : typeof resultContent === 'string' ? resultContent : resultContent ? JSON.stringify(resultContent, null, 2) : '';
    const resultElapsedMs: number | null = hasStructuredResult ? resultContent.elapsed_ms ?? null : null;
    const parsedResult = useMemo(() => (result ? parseToolResult(toolName, resultRawText) : null), [result, toolName, resultRawText]);
    const resultSummary = result ? getResultSummary(toolName, resultRawText) : null;
    const isError = resultSummary?.startsWith('✗') || (parsedResult?.type === 'bash' && parsedResult.exitCode !== null && parsedResult.exitCode !== 0) || (parsedResult?.type === 'text' && parsedResult.isError);
    const toggle = useCallback(() => { if (!isStreaming) setExpanded((v) => !v); }, [isStreaming]);
    const accentRgb = c.accent.primary.replace('#', '').match(/.{2}/g)?.map((h) => parseInt(h, 16)).join(', ') || '189, 100, 57';
    const promptPrefix = getPromptPrefix(toolName);
    const shortAction = mcpInfo.isMcp ? getMcpShortAction(mcpInfo) : toolName;
    const serviceLabel = mcpInfo.isMcp && mcpInfo.service ? mcpInfo.service.charAt(0).toUpperCase() + mcpInfo.service.slice(1) : shortAction;
    const ServiceIcon = mcpInfo.isMcp && mcpInfo.service ? <GoogleServiceIcon service={mcpInfo.service} size={14} /> : null;
    const selectAttrs = { 'data-select-type': 'tool-call' as const, 'data-select-id': call.id, 'data-select-meta': JSON.stringify({ tool: toolName, inputSummary }) };

    if (isInvokeAgentTool(toolName)) return <InvokeAgentBubble call={call} result={result} isPending={isPending} isStreaming={isStreaming} sessionId={sessionId} />;
    if (isCreateAgentTool(toolName)) return <CreateAgentBubble call={call} result={result} isPending={isPending} isStreaming={isStreaming} sessionId={sessionId} />;

    if (mcpCompact && mcpInfo.isMcp) {
      return (
        <Box {...selectAttrs} sx={{ my: 0 }}>
          <Box onClick={toggle} sx={{ display: 'flex', alignItems: showBody ? 'flex-start' : 'center', gap: 0.75, px: 1.5, py: 0.6, cursor: 'pointer', borderBottom: showBody ? `1px solid ${c.border.subtle}` : 'none', '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' } }}>
            {ServiceIcon}
            <Typography sx={{ color: c.accent.primary, fontSize: '0.78rem', fontWeight: 600, flexShrink: 0 }}>{serviceLabel}</Typography>
            {resultSummary && !isError && (
              <Typography sx={{ color: c.text.secondary, fontSize: '0.74rem', flex: 1, minWidth: 0, ...(showBody ? { whiteSpace: 'normal', wordBreak: 'break-word' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }}>{resultSummary}</Typography>
            )}
            {!resultSummary && !showTimer && <Box sx={{ flex: 1 }} />}
            {showTimer && <><Box sx={{ flex: 1 }} /><ElapsedTimer startTime={call.timestamp} /></>}
            {isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
                <BlockIcon sx={{ fontSize: 12, color: c.status.error }} />
                <Typography sx={{ color: c.status.error, fontSize: '0.68rem', fontWeight: 500 }}>denied</Typography>
              </Box>
            )}
            {result && !isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                {isError ? <ErrorOutlineIcon sx={{ fontSize: 12, color: c.status.error }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 12, color: c.status.success }} />}
                {resultElapsedMs != null && <Typography sx={{ fontSize: '0.63rem', fontFamily: c.font.mono, color: c.text.tertiary }}>{formatElapsed(resultElapsedMs)}</Typography>}
              </Box>
            )}
            <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.15, flexShrink: 0 }}>
              {showBody ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Box>
          <Collapse in={showBody}>
            <Box sx={{ bgcolor: tc.TERM_BG, maxHeight: '60vh', overflowY: 'auto', overflowX: 'hidden', '&::-webkit-scrollbar': { width: 5 }, '&::-webkit-scrollbar-track': { background: 'transparent' }, '&::-webkit-scrollbar-thumb': { background: tc.SCROLLBAR_THUMB, borderRadius: 3 } }}>
              {isBrowserAgent && sessionId && <BrowserFeedTracker parentSessionId={sessionId} browserId={input?.browser_id} />}
              {parsedResult && parsedResult.type === 'mcp' ? (
                renderParsedMcpData(parsedResult.service, parsedResult.action, parsedResult.data, call.id)
              ) : parsedResult ? (
                <pre style={{ margin: 0, padding: '8px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: c.font.mono, fontSize: '0.73rem', lineHeight: 1.5, color: tc.OUTPUT_COLOR }}>{parsedResult.type === 'text' ? parsedResult.content : ''}</pre>
              ) : null}
              {!parsedResult && isPending && !isStreaming && !isBrowserAgent && (
                <Box sx={{ px: 1.5, py: 1 }}><Box sx={{ width: 8, height: 2, bgcolor: tc.PROMPT_COLOR, animation: 'tool-pulse 1s ease-in-out infinite', borderRadius: 1 }} /></Box>
              )}
            </Box>
          </Collapse>
        </Box>
      );
    }

    return (
      <Box {...selectAttrs} sx={{ maxWidth: mcpCompact ? '100%' : '85%', my: mcpCompact ? 0 : 0.5 }}>
        <Box sx={{ '--glow-rgb': accentRgb, bgcolor: mcpCompact ? 'transparent' : c.bg.elevated, border: mcpCompact ? 'none' : `1px solid ${isPending || isStreaming ? c.accent.primary : isDenied ? c.status.error + '60' : c.border.subtle}`, borderRadius: mcpCompact ? 0 : 2, overflow: 'hidden', animation: (isPending || isStreaming) && !mcpCompact ? 'border-glow 2s ease-in-out infinite' : 'none', transition: 'border-color 0.3s, box-shadow 0.3s' } as any}>
          <Box onClick={toggle} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: mcpCompact ? 0.6 : 0.75, cursor: isStreaming ? 'default' : 'pointer', borderBottom: mcpCompact && showBody ? `1px solid ${c.border.subtle}` : 'none', '&:hover': isStreaming ? {} : { bgcolor: 'rgba(0,0,0,0.02)' } }}>
            {mcpInfo.isMcp && mcpInfo.service
              ? <GoogleServiceIcon service={mcpInfo.service} size={mcpCompact ? 14 : 15} />
              : (() => { const n = toolName.toLowerCase(); if (n.includes('search') || n === 'grep' || n === 'glob') return <SearchIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: c.accent.primary, flexShrink: 0 }} />; return <TerminalIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: c.accent.primary, flexShrink: 0 }} />; })()}
            <Typography sx={{ color: c.accent.primary, fontSize: mcpCompact ? '0.78rem' : '0.8rem', fontWeight: 600, flexShrink: 0 }}>{mcpInfo.isMcp ? mcpInfo.displayName : toolName}</Typography>
            {mcpInfo.isMcp && <Typography sx={{ color: c.text.tertiary, fontSize: '0.65rem', opacity: 0.7, flexShrink: 0 }}>{mcpInfo.serverSlug}</Typography>}
            {inputSummary && !isStreaming && <Typography noWrap sx={{ color: c.text.tertiary, fontSize: '0.75rem', fontFamily: c.font.mono, flex: 1, minWidth: 0 }}>{inputSummary}</Typography>}
            {!inputSummary && <Box sx={{ flex: 1 }} />}
            {isStreaming && <Box sx={{ flex: 1 }} />}
            {isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
                <BlockIcon sx={{ fontSize: 13, color: c.status.error }} />
                <Typography sx={{ color: c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>denied</Typography>
              </Box>
            )}
            {result && !isDenied && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {isError ? <ErrorOutlineIcon sx={{ fontSize: 13, color: c.status.error }} /> : <CheckCircleOutlineIcon sx={{ fontSize: 13, color: c.status.success }} />}
                <Typography sx={{ color: isError ? c.status.error : c.status.success, fontSize: '0.7rem', fontWeight: 500 }}>{resultSummary}</Typography>
                {resultElapsedMs != null && <Typography sx={{ fontSize: '0.65rem', fontFamily: c.font.mono, color: c.text.tertiary }}>{formatElapsed(resultElapsedMs)}</Typography>}
              </Box>
            )}
            {showTimer && <ElapsedTimer startTime={call.timestamp} />}
            {!isStreaming && (
              <IconButton size="small" sx={{ color: c.text.tertiary, p: mcpCompact ? 0.15 : 0.25, flexShrink: 0 }}>
                {showBody ? <ExpandLessIcon sx={{ fontSize: mcpCompact ? 16 : 18 }} /> : <ExpandMoreIcon sx={{ fontSize: mcpCompact ? 16 : 18 }} />}
              </IconButton>
            )}
          </Box>
          <Collapse in={showBody}>
            <Box sx={{ bgcolor: tc.TERM_BG, borderTop: `1px solid ${tc.TERM_BORDER}`, maxHeight: 500, overflow: 'auto', '&::-webkit-scrollbar': { width: 5 }, '&::-webkit-scrollbar-track': { background: 'transparent' }, '&::-webkit-scrollbar-thumb': { background: tc.SCROLLBAR_THUMB, borderRadius: 3 } }}>
              <pre style={{ margin: 0, padding: '8px 12px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: c.font.mono, fontSize: '0.73rem', lineHeight: 1.5 }}>
                <span style={{ color: tc.PROMPT_COLOR, fontWeight: 600, userSelect: 'none' }}>{promptPrefix}</span>
                {isStreaming ? <span style={{ color: tc.CMD_COLOR }}>{call.content?.input ?? ''}</span> : colorizeInput(toolName, formattedInput, tc)}
                {isStreaming && <span style={{ display: 'inline-block', width: 2, height: '1em', background: c.accent.primary, marginLeft: 2, verticalAlign: 'text-bottom', animation: 'blink-cursor 0.8s step-end infinite' }} />}
              </pre>
              {isBrowserAgent && sessionId && <BrowserFeedTracker parentSessionId={sessionId} browserId={input?.browser_id} />}
              {parsedResult && parsedResult.type === 'mcp' ? (
                renderParsedMcpData(parsedResult.service, parsedResult.action, parsedResult.data, call.id)
              ) : parsedResult ? (
                <pre style={{ margin: 0, padding: '4px 12px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: c.font.mono, fontSize: '0.73rem', lineHeight: 1.5 }}>
                  {parsedResult.type === 'bash' ? (
                    <>
                      {parsedResult.stdout.trim() && colorizeOutput(toolName, parsedResult.stdout, tc)}
                      {parsedResult.stderr.trim() && <>{parsedResult.stdout.trim() && '\n'}<span style={{ color: tc.STDERR_COLOR }}>{parsedResult.stderr}</span></>}
                      {!parsedResult.stdout.trim() && !parsedResult.stderr.trim() && <span style={{ color: tc.DIM_COLOR, fontStyle: 'italic' }}>(no output)</span>}
                    </>
                  ) : (
                    <>{parsedResult.isError ? <span style={{ color: tc.STDERR_COLOR }}>{parsedResult.content || '(empty)'}</span> : colorizeOutput(toolName, parsedResult.content, tc)}</>
                  )}
                </pre>
              ) : null}
              {!parsedResult && isPending && !isStreaming && !isBrowserAgent && (
                <Box sx={{ px: 1.5, pb: 1, pt: 0.5 }}><Box sx={{ width: 8, height: 2, bgcolor: tc.PROMPT_COLOR, animation: 'tool-pulse 1s ease-in-out infinite', borderRadius: 1 }} /></Box>
              )}
            </Box>
          </Collapse>
        </Box>
      </Box>
    );
  }
);

export default ToolCallBubble;
