import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import CheckIcon from '@mui/icons-material/Check';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import CloseIcon from '@mui/icons-material/Close';
import TerminalIcon from '@mui/icons-material/Terminal';
import { AgentSession } from '@/shared/state/agentsSlice';
import { HANDLE_APPROVAL } from '@/shared/backend-bridge/apps/agents';
import { useAppDispatch } from '@/shared/hooks';
import { ToolQuestion } from '@/app/pages/AgentChat/toolkit/approval-question';
import { parseMcpToolName } from '@/app/pages/AgentChat/toolkit/approval-utils';
import GoogleServiceIcon from './components/GoogleServiceIcon';
import { summarizeToolInput } from './components/summarizeToolInput';
import { getToolDisplayName } from './components/getToolDisplayName';

interface AgentCardCollapsedProps {
  session: AgentSession;
  previewContent: string;
  isStreaming: boolean;
  hasPending: boolean;
  statusStyle: { color: string; bg: string };
  c: Record<string, any>;
}

const AgentCardCollapsed: React.FC<AgentCardCollapsedProps> = ({
  session,
  previewContent,
  isStreaming,
  hasPending,
  statusStyle,
  c,
}) => {
  const dispatch = useAppDispatch();
  const pendingReq = session.pending_approvals[0];

  return (
    <>
      {previewContent && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: hasPending ? 1.5 : 0 }}>
          {isStreaming && (
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: c.accent.primary,
                flexShrink: 0,
                animation: 'pulse-dot 1.4s ease-in-out infinite',
                '@keyframes pulse-dot': {
                  '0%, 100%': { opacity: 0.4, transform: 'scale(0.8)' },
                  '50%': { opacity: 1, transform: 'scale(1.2)' },
                },
              }}
            />
          )}
          <Typography
            variant="body2"
            sx={{
              color: isStreaming ? c.text.secondary : c.text.muted,
              fontSize: '0.8rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {previewContent}
          </Typography>
        </Box>
      )}

      {hasPending && pendingReq && pendingReq.tool_name === 'AskUserQuestion' ? (
        <Box onClick={(e) => e.stopPropagation()}>
          <ToolQuestion
            compact
            request={pendingReq}
            onApprove={(requestId, updatedInput) =>
              dispatch(HANDLE_APPROVAL({ requestId, behavior: 'allow', updatedInput }))
            }
            onDeny={(requestId) =>
              dispatch(HANDLE_APPROVAL({ requestId, behavior: 'deny' }))
            }
          />
        </Box>
      ) : hasPending ? (
        <Box onClick={(e) => e.stopPropagation()} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {pendingReq && (
            <Box
              sx={{
                bgcolor: c.status.warningBg,
                border: `1px solid rgba(128,92,31,0.2)`,
                borderRadius: 2,
                p: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
                {(() => {
                  const mcp = parseMcpToolName(pendingReq.tool_name);
                  if (mcp.isMcp && mcp.service) return <GoogleServiceIcon service={mcp.service} size={18} />;
                  return <TerminalIcon sx={{ fontSize: 16, color: c.status.warning, flexShrink: 0, opacity: 0.8 }} />;
                })()}
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ color: c.status.warning, fontSize: '0.75rem', fontWeight: 600 }}>
                    {getToolDisplayName(pendingReq.tool_name)}
                  </Typography>
                  <Typography
                    sx={{
                      color: c.text.muted,
                      fontSize: '0.7rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {summarizeToolInput(pendingReq.tool_name, pendingReq.tool_input)}
                  </Typography>
                </Box>
              </Box>
              {session.pending_approvals.length === 1 && (
                <Box sx={{ display: 'flex', gap: 0.5, ml: 1 }}>
                  <Tooltip title="Approve">
                    <IconButton
                      size="small"
                      onClick={() => dispatch(HANDLE_APPROVAL({ requestId: pendingReq.id, behavior: 'allow' }))}
                      sx={{ color: c.status.success }}
                    >
                      <CheckCircleIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Deny">
                    <IconButton
                      size="small"
                      onClick={() => dispatch(HANDLE_APPROVAL({ requestId: pendingReq.id, behavior: 'deny' }))}
                      sx={{ color: c.status.error }}
                    >
                      <CancelIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
            </Box>
          )}
          {session.pending_approvals.length > 1 && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                bgcolor: c.status.warningBg,
                border: `1px solid rgba(128,92,31,0.2)`,
                borderRadius: 2,
                px: 1.25,
                py: 0.75,
              }}
            >
              <Typography sx={{ fontSize: '0.75rem', fontWeight: 700, color: c.status.warning, flex: 1 }}>
                {session.pending_approvals.length} pending approvals
              </Typography>
              <Button
                variant="contained"
                size="small"
                startIcon={<CheckIcon sx={{ fontSize: '14px !important' }} />}
                onClick={() => {
                  for (const req of session.pending_approvals) {
                    if (req.tool_name !== 'AskUserQuestion') dispatch(HANDLE_APPROVAL({ requestId: req.id, behavior: 'allow' }));
                  }
                }}
                sx={{
                  bgcolor: c.status.success,
                  '&:hover': { bgcolor: '#1e4d15' },
                  fontWeight: 600,
                  fontSize: '0.72rem',
                  textTransform: 'none',
                  borderRadius: 1.5,
                  px: 1.25,
                  py: 0.25,
                  minHeight: 26,
                  minWidth: 0,
                }}
              >
                Approve All
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CloseIcon sx={{ fontSize: '14px !important' }} />}
                onClick={() => {
                  for (const req of session.pending_approvals) {
                    if (req.tool_name !== 'AskUserQuestion') dispatch(HANDLE_APPROVAL({ requestId: req.id, behavior: 'deny' }));
                  }
                }}
                sx={{
                  borderColor: c.status.error,
                  color: c.status.error,
                  '&:hover': { borderColor: '#8f2828', bgcolor: 'rgba(181,51,51,0.04)' },
                  fontWeight: 600,
                  fontSize: '0.72rem',
                  textTransform: 'none',
                  borderRadius: 1.5,
                  px: 1.25,
                  py: 0.25,
                  minHeight: 26,
                  minWidth: 0,
                }}
              >
                Deny All
              </Button>
            </Box>
          )}
        </Box>
      ) : null}
    </>
  );
};

export default React.memo(AgentCardCollapsed);
