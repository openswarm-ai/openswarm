import React, { useMemo, useCallback, useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { handleApproval, ApprovalRequest } from '@/shared/state/agentsSlice';
import ApprovalBar, { BatchApprovalBar } from '@/app/pages/AgentChat/ApprovalBar';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface SessionApprovalGroup {
  sessionId: string;
  sessionName: string;
  approvals: ApprovalRequest[];
}

const GlobalApprovalOverlay: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const sessions = useAppSelector((state) => state.agents.sessions);
  const [collapsed, setCollapsed] = useState(false);

  const groups: SessionApprovalGroup[] = useMemo(() => {
    const result: SessionApprovalGroup[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.pending_approvals.length > 0) {
        result.push({
          sessionId,
          sessionName: session.name || 'Agent',
          approvals: session.pending_approvals,
        });
      }
    }
    return result;
  }, [sessions]);

  const totalApprovals = useMemo(
    () => groups.reduce((sum, g) => sum + g.approvals.length, 0),
    [groups],
  );

  useEffect(() => {
    if (totalApprovals > 0) {
      setCollapsed(false);
    }
  }, [totalApprovals]);

  const onApprove = useCallback(
    (requestId: string, updatedInput?: Record<string, any>) => {
      dispatch(handleApproval({ requestId, behavior: 'allow', updatedInput }));
    },
    [dispatch],
  );

  const onDeny = useCallback(
    (requestId: string, message?: string) => {
      dispatch(handleApproval({ requestId, behavior: 'deny', message }));
    },
    [dispatch],
  );

  if (totalApprovals === 0) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        width: collapsed ? 'auto' : 420,
        maxWidth: 'calc(100vw - 280px)',
        maxHeight: 'calc(100vh - 32px)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: `${c.radius.xl}px`,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.status.warning}40`,
        boxShadow: `0 8px 32px rgba(0,0,0,0.25), 0 0 0 1px ${c.status.warning}20`,
        overflow: 'hidden',
        animation: 'approvalSlideIn 0.25s ease-out',
        '@keyframes approvalSlideIn': {
          from: { opacity: 0, transform: 'translateY(-12px) scale(0.97)' },
          to: { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
      }}
    >
      {/* Header */}
      <Box
        onClick={() => setCollapsed((v) => !v)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.25,
          bgcolor: c.status.warningBg,
          borderBottom: collapsed ? 'none' : `1px solid ${c.status.warning}20`,
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: `${c.status.warning}18` },
          transition: 'background-color 0.15s',
        }}
      >
        <NotificationsActiveIcon
          sx={{
            fontSize: 18,
            color: c.status.warning,
            animation: 'approvalBell 0.6s ease-in-out',
            '@keyframes approvalBell': {
              '0%': { transform: 'rotate(0)' },
              '20%': { transform: 'rotate(12deg)' },
              '40%': { transform: 'rotate(-10deg)' },
              '60%': { transform: 'rotate(6deg)' },
              '80%': { transform: 'rotate(-3deg)' },
              '100%': { transform: 'rotate(0)' },
            },
          }}
        />
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: c.status.warning, flex: 1 }}>
          Approval Required
        </Typography>
        <Chip
          label={totalApprovals}
          size="small"
          sx={{
            height: 22,
            minWidth: 28,
            fontSize: '0.75rem',
            fontWeight: 700,
            bgcolor: `${c.status.warning}20`,
            color: c.status.warning,
            border: 'none',
          }}
        />
        <IconButton size="small" sx={{ color: c.text.ghost, p: 0.25 }}>
          {collapsed ? <ExpandMoreIcon sx={{ fontSize: 18 }} /> : <ExpandLessIcon sx={{ fontSize: 18 }} />}
        </IconButton>
      </Box>

      {/* Content */}
      {!collapsed && (
        <Box
          sx={{
            overflow: 'auto',
            py: 1,
            maxHeight: 'calc(100vh - 120px)',
            '&::-webkit-scrollbar': { width: 5 },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: c.border.medium,
              borderRadius: 3,
              '&:hover': { background: c.border.strong },
            },
            scrollbarWidth: 'thin',
            scrollbarColor: `${c.border.medium} transparent`,
          }}
        >
          {groups.map((group) => (
            <Box key={group.sessionId} sx={{ mb: 1, '&:last-child': { mb: 0 } }}>
              {groups.length > 1 && (
                <Typography
                  sx={{
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    color: c.text.muted,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    px: 2,
                    py: 0.5,
                  }}
                >
                  {group.sessionName}
                </Typography>
              )}
              {group.approvals.length > 1 ? (
                <BatchApprovalBar
                  requests={group.approvals}
                  onApprove={onApprove}
                  onDeny={onDeny}
                />
              ) : (
                group.approvals.map((req) => (
                  <ApprovalBar
                    key={req.id}
                    request={req}
                    onApprove={onApprove}
                    onDeny={onDeny}
                  />
                ))
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default GlobalApprovalOverlay;
