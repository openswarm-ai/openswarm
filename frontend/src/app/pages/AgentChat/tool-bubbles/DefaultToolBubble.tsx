import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import TerminalIcon from '@mui/icons-material/Terminal';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import SearchIcon from '@mui/icons-material/Search';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getToolLabelWithInput } from '../parsing/toolLabels';
import BrowserAgentInlineFeed from '../shell/BrowserAgentInlineFeed';
import { GoogleServiceIcon } from '../mcp-cards/GoogleServiceIcon';
import { ElapsedTimer, formatElapsed } from '../parsing/toolBubbleChrome';
import { useTermColors, colorizeInput, colorizeOutput } from '../parsing/toolColorize';
import { ParsedResult } from '../parsing/toolResultParsing';
import { McpToolInfo } from '@/shared/mcpToolMeta';
import { McpResultCard } from '../mcp-cards/McpResultCard';

interface DefaultToolBubbleProps {
  call: AgentMessage;
  input: any;
  sessionId?: string;
  mcpCompact: boolean;
  isPending: boolean;
  isStreaming: boolean;
  isDenied: boolean;
  isError: boolean;
  result: AgentMessage | null;
  mcpInfo: McpToolInfo;
  toolName: string;
  inputSummary: string;
  formattedInput: string;
  promptPrefix: string;
  resultSummary: string | null;
  resultElapsedMs: number | null;
  showTimer: boolean;
  showBody: boolean;
  toggle: () => void;
  parsedResult: ParsedResult | null;
  isBrowserAgent: boolean;
  accentRgb: string;
  selectAttrs: Record<string, string>;
}

export const DefaultToolBubble: React.FC<DefaultToolBubbleProps> = ({
  call, input, sessionId, mcpCompact, isPending, isStreaming, isDenied, isError, result,
  mcpInfo, toolName, inputSummary, formattedInput, promptPrefix, resultSummary, resultElapsedMs,
  showTimer, showBody, toggle, parsedResult, isBrowserAgent, accentRgb, selectAttrs,
}) => {
  const c = useClaudeTokens();
  const tc = useTermColors();

  return (
    <Box {...selectAttrs} sx={{ maxWidth: mcpCompact ? '100%' : '85%', my: mcpCompact ? 0 : 0.5 }}>
      <Box
        sx={{
          '--glow-rgb': accentRgb,
          bgcolor: mcpCompact ? 'transparent' : c.bg.elevated,
          border: mcpCompact ? 'none' : `1px solid ${
            isPending || isStreaming
              ? c.accent.primary
              : isDenied
                ? c.status.error + '60'
                : c.border.subtle
          }`,
          borderRadius: mcpCompact ? 0 : 2,
          overflow: 'hidden',
          animation: (isPending || isStreaming) && !mcpCompact ? 'border-glow 2s ease-in-out infinite' : 'none',
          transition: 'border-color 0.3s, box-shadow 0.3s',
        } as any}
      >
        <Box
          onClick={toggle}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.5,
            py: mcpCompact ? 0.6 : 0.75,
            cursor: isStreaming ? 'default' : 'pointer',
            borderBottom: mcpCompact && showBody ? `1px solid ${c.border.subtle}` : 'none',
            '&:hover': isStreaming ? {} : { bgcolor: 'rgba(0,0,0,0.02)' },
          }}
        >
          {mcpInfo.isMcp && mcpInfo.service
            ? <GoogleServiceIcon service={mcpInfo.service} size={mcpCompact ? 14 : 15} />
            : (() => {
                const n = toolName.toLowerCase();
                if (n.includes('search') || n === 'grep' || n === 'glob')
                  return <SearchIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: c.accent.primary, flexShrink: 0 }} />;
                return <TerminalIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: c.accent.primary, flexShrink: 0 }} />;
              })()
          }
          <Typography
            sx={{
              color: c.accent.primary,
              fontSize: mcpCompact ? '0.78rem' : '0.8rem',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {(() => {
              const { present, past } = getToolLabelWithInput(toolName, input, call.id);
              return result && !isDenied ? past : present;
            })()}
          </Typography>
          {mcpInfo.isMcp && (
            <Typography
              sx={{
                color: c.text.tertiary,
                fontSize: '0.65rem',
                opacity: 0.7,
                flexShrink: 0,
              }}
            >
              {mcpInfo.serverSlug}
            </Typography>
          )}
          {inputSummary && !isStreaming && (
            <Typography
              noWrap
              sx={{
                color: c.text.tertiary,
                fontSize: '0.75rem',
                fontFamily: c.font.mono,
                flex: 1,
                minWidth: 0,
              }}
            >
              {inputSummary}
            </Typography>
          )}
          {!inputSummary && <Box sx={{ flex: 1 }} />}
          {isStreaming && <Box sx={{ flex: 1 }} />}
          {isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
              <BlockIcon sx={{ fontSize: 13, color: c.status.error }} />
              <Typography sx={{ color: c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>
                denied
              </Typography>
            </Box>
          )}
          {result && !isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {isError && (
                <>
                  <ErrorOutlineIcon sx={{ fontSize: 13, color: c.status.error }} />
                  {resultSummary && (
                    <Typography sx={{ color: c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>
                      {resultSummary}
                    </Typography>
                  )}
                </>
              )}
              {resultElapsedMs != null && (
                <Typography
                  sx={{
                    fontSize: '0.65rem',
                    fontFamily: c.font.mono,
                    color: c.text.tertiary,
                  }}
                >
                  {formatElapsed(resultElapsedMs)}
                </Typography>
              )}
            </Box>
          )}
          {showTimer && <ElapsedTimer startTime={call.timestamp} />}

          {!isStreaming && (
            <IconButton size="small" sx={{ color: c.text.tertiary, p: mcpCompact ? 0.15 : 0.25, flexShrink: 0 }}>
              {showBody ? (
                <ExpandLessIcon sx={{ fontSize: mcpCompact ? 16 : 18 }} />
              ) : (
                <ExpandMoreIcon sx={{ fontSize: mcpCompact ? 16 : 18 }} />
              )}
            </IconButton>
          )}
        </Box>

        <Collapse in={showBody}>
          <Box
            sx={{
              bgcolor: tc.TERM_BG,
              borderTop: `1px solid ${tc.TERM_BORDER}`,
              maxHeight: 500,
              overflow: 'auto',
              '&::-webkit-scrollbar': { width: 5 },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
              '&::-webkit-scrollbar-thumb': {
                background: tc.SCROLLBAR_THUMB,
                borderRadius: 3,
              },
            }}
          >
            <pre
              style={{
                margin: 0,
                padding: '8px 12px 0',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: c.font.mono,
                fontSize: '0.73rem',
                lineHeight: 1.5,
              }}
            >
              <span style={{ color: tc.PROMPT_COLOR, fontWeight: 600, userSelect: 'none' }}>
                {promptPrefix}
              </span>
              {isStreaming ? (
                <span style={{ color: tc.CMD_COLOR }}>{call.content?.input ?? ''}</span>
              ) : (
                colorizeInput(toolName, formattedInput, tc)
              )}
              {isStreaming && (
                <span
                  style={{
                    display: 'inline-block',
                    width: 2,
                    height: '1em',
                    background: c.accent.primary,
                    marginLeft: 2,
                    verticalAlign: 'text-bottom',
                    animation: 'blink-cursor 0.8s step-end infinite',
                  }}
                />
              )}
            </pre>

            {isBrowserAgent && sessionId && (
              <BrowserAgentInlineFeed
                parentSessionId={sessionId}
                browserId={input?.browser_id}
              />
            )}

            {parsedResult && parsedResult.type === 'mcp' ? (
              <McpResultCard parsed={parsedResult} />
            ) : parsedResult ? (
              <pre
                style={{
                  margin: 0,
                  padding: '4px 12px 8px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: c.font.mono,
                  fontSize: '0.73rem',
                  lineHeight: 1.5,
                }}
              >
                {parsedResult.type === 'bash' ? (
                  <>
                    {parsedResult.stdout.trim() &&
                      colorizeOutput(toolName, parsedResult.stdout, tc)}
                    {parsedResult.stderr.trim() && (
                      <>
                        {parsedResult.stdout.trim() && '\n'}
                        <span style={{ color: tc.STDERR_COLOR }}>{parsedResult.stderr}</span>
                      </>
                    )}
                    {!parsedResult.stdout.trim() && !parsedResult.stderr.trim() && (
                      <span style={{ color: tc.DIM_COLOR, fontStyle: 'italic' }}>(no output)</span>
                    )}
                  </>
                ) : (
                  <>
                    {parsedResult.isError ? (
                      <span style={{ color: tc.STDERR_COLOR }}>{parsedResult.content || '(empty)'}</span>
                    ) : (
                      colorizeOutput(toolName, parsedResult.content, tc)
                    )}
                  </>
                )}
              </pre>
            ) : null}

            {!parsedResult && isPending && !isStreaming && !isBrowserAgent && (
              <Box sx={{ px: 1.5, pb: 1, pt: 0.5 }}>
                <Box
                  sx={{
                    width: 8,
                    height: 2,
                    bgcolor: tc.PROMPT_COLOR,
                    animation: 'tool-pulse 1s ease-in-out infinite',
                    borderRadius: 1,
                  }}
                />
              </Box>
            )}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
};
