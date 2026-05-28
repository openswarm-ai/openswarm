import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getToolLabel } from '../parsing/toolLabels';
import BrowserAgentInlineFeed from '../shell/BrowserAgentInlineFeed';
import { GoogleServiceIcon } from '../mcp-cards/GoogleServiceIcon';
import { ElapsedTimer, formatElapsed } from '../parsing/toolBubbleChrome';
import { useTermColors } from '../parsing/toolColorize';
import { ParsedResult } from '../parsing/toolResultParsing';
import { McpToolInfo, getMcpShortAction } from '@/shared/mcpToolMeta';
import { McpResultCard } from '../mcp-cards/McpResultCard';

interface CompactMcpBubbleProps {
  call: AgentMessage;
  input: any;
  sessionId?: string;
  isPending: boolean;
  isStreaming: boolean;
  isDenied: boolean;
  isError: boolean;
  result: AgentMessage | null;
  mcpInfo: McpToolInfo;
  toolName: string;
  resultSummary: string | null;
  resultElapsedMs: number | null;
  showTimer: boolean;
  showBody: boolean;
  toggle: () => void;
  parsedResult: ParsedResult | null;
  isBrowserAgent: boolean;
  selectAttrs: Record<string, string>;
}

export const CompactMcpBubble: React.FC<CompactMcpBubbleProps> = ({
  call, input, sessionId, isPending, isStreaming, isDenied, isError, result,
  mcpInfo, toolName, resultSummary, resultElapsedMs, showTimer, showBody, toggle, parsedResult,
  isBrowserAgent, selectAttrs,
}) => {
  const c = useClaudeTokens();
  const tc = useTermColors();

  const shortAction = mcpInfo.isMcp ? getMcpShortAction(mcpInfo) : toolName;
  const mcpVerbLabel = (() => {
    const lbl = getToolLabel(toolName, call.id);
    return result && !isDenied ? lbl.past : lbl.present;
  })();
  const serviceLabel = mcpInfo.isMcp ? mcpVerbLabel : shortAction;
  const ServiceIcon = mcpInfo.isMcp && mcpInfo.service
    ? <GoogleServiceIcon service={mcpInfo.service} size={14} />
    : null;

  return (
    <Box {...selectAttrs} sx={{ my: 0 }}>
      <Box
        onClick={toggle}
        sx={{
          display: 'flex',
          alignItems: showBody ? 'flex-start' : 'center',
          gap: 0.75,
          px: 1.5,
          py: 0.6,
          cursor: 'pointer',
          borderBottom: showBody ? `1px solid ${c.border.subtle}` : 'none',
          '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' },
        }}
      >
        {ServiceIcon}
        <Typography
          sx={{
            color: c.accent.primary,
            fontSize: '0.78rem',
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {serviceLabel}
        </Typography>
        {resultSummary && !isError && (
          <Typography
            sx={{
              color: c.text.secondary,
              fontSize: '0.74rem',
              flex: 1,
              minWidth: 0,
              ...(showBody
                ? { whiteSpace: 'normal', wordBreak: 'break-word' }
                : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
            }}
          >
            {resultSummary}
          </Typography>
        )}
        {!resultSummary && !showTimer && <Box sx={{ flex: 1 }} />}
        {showTimer && (
          <>
            <Box sx={{ flex: 1 }} />
            <ElapsedTimer startTime={call.timestamp} />
          </>
        )}
        {isDenied && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
            <BlockIcon sx={{ fontSize: 12, color: c.status.error }} />
            <Typography sx={{ color: c.status.error, fontSize: '0.68rem', fontWeight: 500 }}>denied</Typography>
          </Box>
        )}
        {result && !isDenied && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
            {isError && (
              <ErrorOutlineIcon sx={{ fontSize: 12, color: c.status.error }} />
            )}
            {resultElapsedMs != null && (
              <Typography sx={{ fontSize: '0.63rem', fontFamily: c.font.mono, color: c.text.tertiary }}>
                {formatElapsed(resultElapsedMs)}
              </Typography>
            )}
          </Box>
        )}
        <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.15, flexShrink: 0 }}>
          {showBody ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Box>

      <Collapse in={showBody}>
        <Box
          sx={{
            bgcolor: tc.TERM_BG,
            maxHeight: '60vh',
            overflowY: 'auto',
            overflowX: 'hidden',
            '&::-webkit-scrollbar': { width: 5 },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': { background: tc.SCROLLBAR_THUMB, borderRadius: 3 },
          }}
        >
          {isBrowserAgent && sessionId && (
            <BrowserAgentInlineFeed
              parentSessionId={sessionId}
              browserId={input?.browser_id}
            />
          )}
          {parsedResult && parsedResult.type === 'mcp' ? (
            <McpResultCard parsed={parsedResult} compact />
          ) : parsedResult ? (
            <pre style={{
              margin: 0, padding: '8px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontFamily: c.font.mono, fontSize: '0.73rem', lineHeight: 1.5, color: tc.OUTPUT_COLOR,
            }}>
              {parsedResult.type === 'text' ? parsedResult.content : ''}
            </pre>
          ) : null}
          {!parsedResult && isPending && !isStreaming && !isBrowserAgent && (
            <Box sx={{ px: 1.5, py: 1 }}>
              <Box sx={{ width: 8, height: 2, bgcolor: tc.PROMPT_COLOR, animation: 'tool-pulse 1s ease-in-out infinite', borderRadius: 1 }} />
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
};
