import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import SearchIcon from '@mui/icons-material/Search';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getToolLabel } from '../parsing/toolLabels';
import BrowserAgentInlineFeed from '../shell/BrowserAgentInlineFeed';
import { GoogleServiceIcon } from '../mcp-cards/GoogleServiceIcon';
import { ElapsedTimer, formatElapsed } from '../parsing/toolBubbleChrome';
import { useTermColors } from '../parsing/toolColorize';
import { ParsedResult } from '../parsing/toolResultParsing';
import { isSettingsWriteTool, settingsWriteSummary } from '../parsing/settingsToolMeta';
import { McpToolInfo, getMcpShortAction, getMcpInputSummary, getWorkflowToolLabel } from '@/shared/mcpToolMeta';
import { McpResultCard } from '../mcp-cards/McpResultCard';
import { domainFromUrl, faviconUrlForDomain } from './SourceFavicons';

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

  const workflowLabel = mcpInfo.isMcp ? getWorkflowToolLabel(mcpInfo.action) : null;
  const shortAction = workflowLabel || (mcpInfo.isMcp ? getMcpShortAction(mcpInfo) : toolName);
  const mcpVerbLabel = (() => {
    if (workflowLabel) return workflowLabel;
    const lbl = getToolLabel(toolName, call.id);
    return result && !isDenied ? lbl.past : lbl.present;
  })();
  const serviceLabel = mcpInfo.isMcp ? mcpVerbLabel : shortAction;
  const inputSummary = mcpInfo.isMcp ? getMcpInputSummary(input, mcpInfo.action, mcpInfo.serverSlug) : '';
  // Web rows read as sources: favicon beside the domain/query, body text instead of mono.
  const isWebRow = /web(fetch|search)$/i.test(toolName);
  const webDomain = /webfetch$/i.test(toolName) && typeof input?.url === 'string' ? domainFromUrl(input.url) : '';
  // A grouped settings write shows the masked change list (input-derived, so it reads even while pending) instead of the generic "Applied: theme" result line.
  const visibleSummary = isSettingsWriteTool(toolName)
    ? settingsWriteSummary(input)
    : (resultSummary || inputSummary);
  const canToggleDetails = !!visibleSummary;
  const hideVerbLabel = !!workflowLabel && !!visibleSummary;
  const ServiceIcon = mcpInfo.isMcp && mcpInfo.service
    ? <GoogleServiceIcon service={mcpInfo.service} size={14} />
    : null;

  // Once expanded (and there's a label above it), the args drop to their own full-width line instead of fighting the label for a cramped column that breaks URLs mid-token.
  const stackBelow = showBody && canToggleDetails && !hideVerbLabel && !!visibleSummary && !isError;

  return (
    <Box {...selectAttrs} sx={{ my: 0 }}>
      <Box
        onClick={canToggleDetails ? toggle : undefined}
        sx={{
          cursor: canToggleDetails ? 'pointer' : 'default',
          borderBottom: showBody && canToggleDetails ? `1px solid ${c.border.subtle}` : 'none',
          '&:hover': canToggleDetails ? { bgcolor: 'rgba(0,0,0,0.02)' } : undefined,
        }}
      >
        <Box className="osw-mcp-row" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.6 }}>
          {ServiceIcon}
          {/* Web rows drop the repeated verb (the group header already says "Searched the web"); a
              muted glyph + the source carries the row, so the card isn't a wall of accent green. */}
          {isWebRow && !webDomain && (
            <SearchIcon sx={{ fontSize: 13, color: c.text.tertiary, flexShrink: 0 }} />
          )}
          {!hideVerbLabel && !isWebRow && (
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
          )}
          {visibleSummary && !isError && !stackBelow && (
            <>
              {webDomain && (
                <Box
                  component="img"
                  src={faviconUrlForDomain(webDomain)}
                  alt=""
                  loading="lazy"
                  onError={(e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.display = 'none'; }}
                  sx={{ width: 13, height: 13, borderRadius: '3px', flexShrink: 0 }}
                />
              )}
              <Typography
                sx={{
                  color: hideVerbLabel ? c.text.primary : c.text.secondary,
                  fontSize: '0.74rem',
                  // Args are data (ids, URLs, params) and read in mono; web rows are SOURCES and read in body text.
                  fontFamily: isWebRow ? undefined : c.font.mono,
                  flex: 1,
                  minWidth: 0,
                  ...(showBody && canToggleDetails
                    ? { whiteSpace: 'normal', overflowWrap: 'anywhere' }
                    : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                }}
              >
                {visibleSummary}
              </Typography>
            </>
          )}
          {(stackBelow || !visibleSummary) && !showTimer && <Box sx={{ flex: 1 }} />}
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
              {/* Timings are debug detail, not content: ghosted at rest, legible on row hover
                  (LibreChat/ChatGPT show none at all; we keep them one hover away). */}
              {resultElapsedMs != null && (
                <Typography sx={{ fontSize: '0.63rem', fontFamily: c.font.mono, color: c.text.ghost, transition: 'color 120ms', '.osw-mcp-row:hover &': { color: c.text.tertiary } }}>
                  {formatElapsed(resultElapsedMs)}
                </Typography>
              )}
            </Box>
          )}
          {canToggleDetails && (
            <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.15, flexShrink: 0, opacity: 0, transition: 'opacity 120ms', '.osw-mcp-row:hover &': { opacity: 1 }, ...(showBody ? { opacity: 1 } : {}) }}>
              {showBody ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          )}
        </Box>
        {stackBelow && (
          <Typography
            sx={{
              color: c.text.secondary,
              fontSize: '0.74rem',
              fontFamily: c.font.mono,
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              lineHeight: 1.5,
              px: 1.5,
              pb: 0.6,
            }}
          >
            {visibleSummary}
          </Typography>
        )}
      </Box>

      <Collapse in={showBody && canToggleDetails}>
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
