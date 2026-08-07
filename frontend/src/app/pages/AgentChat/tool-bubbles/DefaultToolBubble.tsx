import React from 'react';
import type { ToolSelectAttrs } from './ToolCallBubble';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TerminalIcon from '@mui/icons-material/Terminal';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import SearchIcon from '@mui/icons-material/Search';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useMountReveal } from './useMountReveal';
import { getToolLabelWithInput } from '../parsing/toolLabels';
import BrowserAgentInlineFeed from '../shell/BrowserAgentInlineFeed';
import { GoogleServiceIcon } from '../mcp-cards/GoogleServiceIcon';
import { ElapsedTimer, formatElapsed } from '../parsing/toolBubbleChrome';
import { useTermColors, colorizeInput, colorizeOutput } from '../parsing/toolColorize';
import { ParsedResult, getToolData } from '../parsing/toolResultParsing';
import { resolveRichRender } from '../parsing/richResultDispatch';
import { McpToolInfo } from '@/shared/mcpToolMeta';
import { McpResultCard } from '../mcp-cards/McpResultCard';
import { domainFromUrl } from './SourceFavicons';
import { DomainIcon } from './DomainIcon';
import VendoredToolUi from '@toolui/VendoredToolUi';
import WidgetCopyChip from '../tool-ui/WidgetCopyChip';
import { COLLAPSE_MS, COLLAPSE_EASE, chevronSx, shimmerTextSx, railEnterSx, keepRowAnchored } from './toolRowMotion';

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
  selectAttrs: ToolSelectAttrs;
  suppressReveal?: boolean;
}

export const DefaultToolBubble: React.FC<DefaultToolBubbleProps> = ({
  call, input, sessionId, mcpCompact, isPending, isStreaming, isDenied, isError, result,
  mcpInfo, toolName, inputSummary, formattedInput, promptPrefix, resultSummary, resultElapsedMs,
  showTimer, showBody, toggle, parsedResult, isBrowserAgent, accentRgb, selectAttrs, suppressReveal = false,
}) => {
  const c = useClaudeTokens();
  const tc = useTermColors();
  const richWidgetRef = React.useRef<HTMLDivElement>(null);
  // Auto-elevated rendering: builtin coding tools map onto the vendored terminal/code components by schema, no ShowUI involved; null keeps the classic colorized <pre>. Streaming stays on the classic path (partial args are unparseable).
  const richRender = React.useMemo(
    () => (!isStreaming && result ? resolveRichRender(toolName, input ?? {}, parsedResult, resultElapsedMs, getToolData(call).toolId || call.id) : null),
    [isStreaming, result, toolName, input, parsedResult, resultElapsedMs, call],
  );
  // JS-driven mount reveal (see useMountReveal). The streaming pill itself glides in so a tool enters smoothly the moment it starts; when it commits, AgentChat sets suppressReveal on that same row so the hand-off doesn't re-animate what's already on screen. mcpCompact rows opt out (the group's row-fade handles them).
  const reveal = useMountReveal();
  const enterStyle = (!mcpCompact && !suppressReveal) ? reveal : {};
  const canToggleDetails = !!inputSummary && !isStreaming;
  // A web read shows its SOURCE (favicon + domain), not a url dump; the Perplexity treatment.
  const webDomain = /webfetch$/i.test(toolName) && typeof input?.url === 'string'
    ? domainFromUrl(input.url)
    : '';

  return (
    <Box
      {...selectAttrs}
      sx={{
        maxWidth: mcpCompact ? '100%' : '85%',
        my: mcpCompact ? 0 : 0.5,
        ...enterStyle,
      }}
    >
      <Box sx={{ '--glow-rgb': accentRgb } as any}>
        <Box
          className="osw-tool-row"
          onClick={canToggleDetails ? (e: React.MouseEvent) => { keepRowAnchored(e.currentTarget as HTMLElement); toggle(); } : undefined}
          sx={{
            // Rows are FLAT in every state (Claude/ChatGPT transition language): no capsule at rest,
            // no box on expand; the output hangs off the indent rail below.
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: mcpCompact ? 1.5 : 0,
            py: mcpCompact ? 0.6 : 0.5,
            cursor: canToggleDetails ? 'pointer' : 'default',
            borderBottom: mcpCompact && showBody && canToggleDetails ? `1px solid ${c.border.subtle}` : 'none',
            '&:hover': canToggleDetails ? { opacity: 0.9 } : {},
          }}
        >
          {/* Accent is a LIVE signal only: a finished row goes neutral so a 20-row group reads as calm history, not a wall of orange (open-webui's state language). */}
          {mcpInfo.isMcp && mcpInfo.service
            ? <GoogleServiceIcon service={mcpInfo.service} size={mcpCompact ? 14 : 15} />
            : (() => {
                const n = toolName.toLowerCase();
                const p_iconColor = isPending ? c.accent.primary : c.text.tertiary;
                if (n.includes('search') || n === 'grep' || n === 'glob')
                  return <SearchIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: p_iconColor, flexShrink: 0 }} />;
                return <TerminalIcon sx={{ fontSize: mcpCompact ? 14 : 15, color: p_iconColor, flexShrink: 0 }} />;
              })()
          }
          <Typography
            sx={{
              color: isPending ? c.accent.primary : c.text.secondary,
              fontSize: mcpCompact ? '0.78rem' : '0.8rem',
              fontWeight: isPending ? 600 : 500,
              flexShrink: 0,
              transition: 'color 0.25s ease',
              ...(isPending ? shimmerTextSx(c.accent.primary) : {}),
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
                fontSize: '0.625rem',
                opacity: 0.7,
                flexShrink: 0,
              }}
            >
              {mcpInfo.serverSlug}
            </Typography>
          )}
          {/* A Bash label is already input-derived ("Checked location"), so its raw command fragment
              is noise; the expanded terminal block shows the full command anyway. */}
          {inputSummary && !isStreaming && (!/^bash$/i.test(toolName) || mcpCompact) ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flex: 1, minWidth: 0 }}>
              {webDomain && <DomainIcon domain={webDomain} size={13} />}
              <Typography
                noWrap
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.75rem',
                  fontFamily: webDomain ? undefined : c.font.mono,
                  minWidth: 0,
                }}
              >
                {inputSummary}
              </Typography>
            </Box>
          ) : !isStreaming ? <Box sx={{ flex: 1 }} /> : null}
          {isStreaming && <Box sx={{ flex: 1 }} />}
          {isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
              <BlockIcon sx={{ fontSize: 13, color: c.status.error }} />
              <Typography sx={{ color: c.status.error, fontSize: '0.6875rem', fontWeight: 500 }}>
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
                    <Typography sx={{ color: c.status.error, fontSize: '0.6875rem', fontWeight: 500 }}>
                      {resultSummary}
                    </Typography>
                  )}
                </>
              )}
              {/* Timings are debug detail, not content: ghosted at rest, legible on row hover. */}
              {resultElapsedMs != null && (
                <Typography
                  sx={{
                    fontSize: '0.625rem',
                    fontFamily: c.font.mono,
                    color: c.text.ghost,
                    transition: 'color 120ms',
                    '.osw-tool-row:hover &': { color: c.text.tertiary },
                  }}
                >
                  {formatElapsed(resultElapsedMs)}
                </Typography>
              )}
            </Box>
          )}
          {showTimer && <ElapsedTimer startTime={call.timestamp} />}

          {canToggleDetails && (
            <IconButton size="small" sx={{ color: c.text.tertiary, p: mcpCompact ? 0.15 : 0.25, flexShrink: 0, opacity: showBody ? 1 : 0, transition: 'opacity 120ms', '.osw-tool-row:hover &': { opacity: 1 } }}>
              <ExpandMoreIcon sx={{ fontSize: mcpCompact ? 16 : 18, ...chevronSx(showBody) }} />
            </IconButton>
          )}
        </Box>

        <Collapse in={showBody && canToggleDetails} timeout={COLLAPSE_MS} easing={COLLAPSE_EASE}>
        {/* Standalone rows hang their output off the indent rail; compact rows already sit inside the group's rail. */}
        <Box sx={mcpCompact ? { ...railEnterSx(showBody) } : { borderLeft: `2px solid ${c.border.medium}`, ml: 0.8, pl: 0.75, my: 0.25, ...railEnterSx(showBody) }}>
          {richRender ? (
            <Box sx={{ p: 1, bgcolor: tc.TERM_BG, borderRadius: 1.5, position: 'relative', '&:hover .osw-widget-copy': { opacity: 1 } }}>
              <WidgetCopyChip component={richRender.name} props={richRender.props} containerRef={richWidgetRef} />
              <Box ref={richWidgetRef}>
                <VendoredToolUi name={richRender.name} props={richRender.props} />
              </Box>
              {parsedResult?.platformNote && (
                <Typography sx={{ mt: 0.5, px: 0.5, fontSize: '0.6875rem', color: c.text.tertiary }}>
                  {parsedResult.platformNote}
                </Typography>
              )}
            </Box>
          ) : (
          <Box
            sx={{
              bgcolor: tc.TERM_BG,
              borderRadius: 1.5,
              maxHeight: 'min(40vh, 320px)',
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
                fontSize: '0.75rem',
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
                  fontSize: '0.75rem',
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

            {parsedResult?.platformNote && (
              <Box
                sx={{
                  mx: 1.5,
                  mb: 1,
                  mt: 0.5,
                  px: 1,
                  py: 0.75,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  borderRadius: 1.5,
                }}
              >
                <Typography
                  sx={{
                    color: c.text.secondary,
                    fontSize: '0.75rem',
                    fontFamily: c.font.mono,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    lineHeight: 1.5,
                  }}
                >
                  {parsedResult.platformNote}
                </Typography>
              </Box>
            )}

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
          )}
        </Box>
        </Collapse>
      </Box>
    </Box>
  );
};
