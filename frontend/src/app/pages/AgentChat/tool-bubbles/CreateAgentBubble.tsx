import React from 'react';
import type { ToolSelectAttrs } from './ToolCallBubble';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import { AgentMessage } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ElapsedTimer, formatElapsed } from '../parsing/toolBubbleChrome';
import { AgentResponseBody } from './AgentResponseBody';
import { chevronSx, shimmerTextSx, railEnterSx, pressSx, keepRowAnchored } from './toolRowMotion';

interface CreateAgentBubbleProps {
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
  createAgentResponse: string;
  createAgentSessionId: string | null;
  handleRevealAgent: (e: React.MouseEvent) => void;
  bubbleRef: React.RefObject<HTMLDivElement>;
  selectAttrs: ToolSelectAttrs;
}

export const CreateAgentBubble: React.FC<CreateAgentBubbleProps> = ({
  call, input, isPending, isDenied, isError, resultElapsedMs, expanded, showTimer,
  toggle, accentRgb, createAgentResponse, createAgentSessionId, handleRevealAgent, bubbleRef, selectAttrs,
}) => {
  const c = useClaudeTokens();
  const taskPrompt = input?.prompt || input?.task || input?.message || '';
  const taskLabel = taskPrompt
    ? taskPrompt.length > 40 ? taskPrompt.slice(0, 40) + '…' : taskPrompt
    : '';
  const hasResponse = !!createAgentResponse;

  return (
    <Box ref={bubbleRef} {...selectAttrs} sx={{ maxWidth: '85%', my: 0.5, '--glow-rgb': accentRgb } as any}>
      {/* Flat row like every other tool disclosure: no capsule, accent + shimmer only while live. */}
      <Box
        className="osw-tool-row"
        onClick={(e: React.MouseEvent) => { keepRowAnchored(e.currentTarget as HTMLElement); toggle(); }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          py: 0.5,
          cursor: hasResponse ? 'pointer' : 'default',
          ...(hasResponse ? pressSx : {}),
        }}
      >
        <CallSplitIcon sx={{ fontSize: 15, color: isPending ? c.accent.primary : c.text.tertiary, flexShrink: 0 }} />
        <Typography
          sx={{
            color: isPending ? c.accent.primary : c.text.secondary,
            fontSize: '0.8125rem',
            fontWeight: isPending ? 600 : 500,
            flexShrink: 0,
            transition: 'color 0.25s ease',
            ...(isPending ? shimmerTextSx(c.accent.primary) : {}),
          }}
        >
          {hasResponse && !isDenied ? 'Ran a sub-agent' : 'Running a sub-agent'}
        </Typography>
        {taskLabel && (
          <Typography noWrap sx={{ fontSize: '0.75rem', color: c.text.tertiary, maxWidth: 200, flexShrink: 1, minWidth: 0 }}>
            {taskLabel}
          </Typography>
        )}

        {!hasResponse && !showTimer && <Box sx={{ flex: 1 }} />}

        {hasResponse && createAgentResponse && !expanded && (
          <Typography
            noWrap
            sx={{ flex: 1, minWidth: 0, fontSize: '0.75rem', color: c.text.tertiary }}
          >
            {createAgentResponse.slice(0, 100)}{createAgentResponse.length > 100 ? '…' : ''}
          </Typography>
        )}
        {expanded && <Box sx={{ flex: 1 }} />}

        {isDenied && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
            <BlockIcon sx={{ fontSize: 13, color: c.status.error }} />
            <Typography sx={{ color: c.status.error, fontSize: '0.6875rem', fontWeight: 500 }}>denied</Typography>
          </Box>
        )}

        {hasResponse && !isDenied && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {isError && (
              <ErrorOutlineIcon sx={{ fontSize: 13, color: c.status.error }} />
            )}
            {/* Timings are debug detail: ghosted at rest, legible on row hover. */}
            {resultElapsedMs != null && (
              <Typography sx={{ fontSize: '0.625rem', fontFamily: c.font.mono, color: c.text.ghost, transition: 'color 120ms', '.osw-tool-row:hover &': { color: c.text.tertiary } }}>
                {formatElapsed(resultElapsedMs)}
              </Typography>
            )}
          </Box>
        )}

        {showTimer && <ElapsedTimer startTime={call.timestamp} />}

        {createAgentSessionId && (
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
          <IconButton size="small" sx={{ color: c.text.tertiary, p: 0.25, flexShrink: 0, opacity: expanded ? 1 : 0, transition: 'opacity 120ms', '.osw-tool-row:hover &': { opacity: 1 } }}>
            <ExpandMoreIcon sx={{ fontSize: 18, ...chevronSx(expanded) }} />
          </IconButton>
        )}
      </Box>

      <Box sx={expanded && hasResponse ? { borderLeft: `2px solid ${c.border.medium}`, ml: 0.8, pl: 0.75, my: 0.25, ...railEnterSx(true) } : {}}>
        <AgentResponseBody open={expanded && hasResponse} markdown={createAgentResponse} />
      </Box>
    </Box>
  );
};
