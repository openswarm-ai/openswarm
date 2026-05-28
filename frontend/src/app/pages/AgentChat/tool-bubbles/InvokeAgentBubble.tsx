import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ElapsedTimer, formatElapsed } from '../parsing/toolBubbleChrome';
import { AgentResponseBody } from './AgentResponseBody';
import { InvokeAgentParsed } from '../parsing/agentToolParsing';

interface InvokeAgentBubbleProps {
  call: AgentMessage;
  input: any;
  isPending: boolean;
  isDenied: boolean;
  isError: boolean;
  resultElapsedMs: number | null;
  expanded: boolean;
  showTimer: boolean;
  toggle: () => void;
  accentRgb: string;
  invokeAgentParsed: InvokeAgentParsed | null;
  invokedSessionId: string | null;
  handleRevealAgent: (e: React.MouseEvent) => void;
  bubbleRef: React.RefObject<HTMLDivElement>;
  selectAttrs: Record<string, string>;
}

export const InvokeAgentBubble: React.FC<InvokeAgentBubbleProps> = ({
  call, input, isPending, isDenied, isError, resultElapsedMs, expanded, showTimer,
  toggle, accentRgb, invokeAgentParsed, invokedSessionId, handleRevealAgent, bubbleRef, selectAttrs,
}) => {
  const c = useClaudeTokens();
  const agentName = invokeAgentParsed?.agentName || input?.session_id || 'Agent';
  const responsePreview = invokeAgentParsed?.response || '';
  const costLabel = invokeAgentParsed?.cost ? `$${invokeAgentParsed.cost}` : null;
  const hasResponse = !!invokeAgentParsed;

  return (
    <Box ref={bubbleRef} {...selectAttrs} sx={{ maxWidth: '85%', my: 0.5 }}>
      <Box
        sx={{
          '--glow-rgb': accentRgb,
          bgcolor: c.bg.elevated,
          border: `1px solid ${
            isPending ? c.accent.primary : isDenied ? c.status.error + '60' : c.border.subtle
          }`,
          borderRadius: 2,
          overflow: 'hidden',
          animation: isPending ? 'border-glow 2s ease-in-out infinite' : 'none',
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
            py: 0.75,
            cursor: hasResponse ? 'pointer' : 'default',
            '&:hover': hasResponse ? { bgcolor: 'rgba(0,0,0,0.02)' } : {},
          }}
        >
          <CallSplitIcon sx={{ fontSize: 15, color: c.accent.primary, flexShrink: 0 }} />
          <Typography
            sx={{
              color: c.accent.primary,
              fontSize: '0.8rem',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            InvokeAgent
          </Typography>
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              bgcolor: `${c.accent.primary}14`,
              borderRadius: 1,
              px: 0.75,
              py: 0.15,
              maxWidth: 180,
              overflow: 'hidden',
            }}
          >
            <Typography
              noWrap
              sx={{
                fontSize: '0.72rem',
                fontWeight: 500,
                color: c.text.secondary,
                fontFamily: c.font.sans,
              }}
            >
              {agentName}
            </Typography>
          </Box>

          {!hasResponse && !showTimer && <Box sx={{ flex: 1 }} />}

          {hasResponse && responsePreview && !expanded && (
            <Typography
              noWrap
              sx={{
                flex: 1,
                minWidth: 0,
                fontSize: '0.73rem',
                color: c.text.tertiary,
                fontFamily: c.font.sans,
              }}
            >
              {responsePreview.slice(0, 100)}{responsePreview.length > 100 ? '…' : ''}
            </Typography>
          )}
          {expanded && <Box sx={{ flex: 1 }} />}

          {isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
              <BlockIcon sx={{ fontSize: 13, color: c.status.error }} />
              <Typography sx={{ color: c.status.error, fontSize: '0.7rem', fontWeight: 500 }}>denied</Typography>
            </Box>
          )}

          {hasResponse && !isDenied && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {isError && (
                <ErrorOutlineIcon sx={{ fontSize: 13, color: c.status.error }} />
              )}
              {resultElapsedMs != null && (
                <Typography sx={{ fontSize: '0.65rem', fontFamily: c.font.mono, color: c.text.tertiary }}>
                  {formatElapsed(resultElapsedMs)}
                </Typography>
              )}
              {costLabel && (
                <Typography sx={{ fontSize: '0.63rem', fontFamily: c.font.mono, color: c.text.tertiary }}>
                  {costLabel}
                </Typography>
              )}
            </Box>
          )}

          {showTimer && <ElapsedTimer startTime={call.timestamp} />}

          {invokedSessionId && (
            <Tooltip title="Reveal on dashboard" arrow>
              <IconButton
                size="small"
                onClick={handleRevealAgent}
                sx={{
                  color: c.accent.primary,
                  p: 0.25,
                  flexShrink: 0,
                  '&:hover': { bgcolor: `${c.accent.primary}18` },
                }}
              >
                <CallSplitIcon sx={{ fontSize: 15, transform: 'rotate(180deg)' }} />
              </IconButton>
            </Tooltip>
          )}

          {hasResponse && (
            <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.25, flexShrink: 0 }}>
              {expanded ? <ExpandLessIcon sx={{ fontSize: 18 }} /> : <ExpandMoreIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          )}
        </Box>

        <AgentResponseBody open={expanded && hasResponse} markdown={responsePreview} />
      </Box>
    </Box>
  );
};
