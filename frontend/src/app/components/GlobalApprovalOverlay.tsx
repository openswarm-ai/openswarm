import React, { useMemo, useCallback, useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  handleApproval,
  stopAgent,
  dismissAgentNotification,
  ApprovalRequest,
  AgentSession,
  HistorySession,
} from '@/shared/state/agentsSlice';
import ApprovalBar, { BatchApprovalBar } from '@/app/pages/AgentChat/ApprovalBar';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface SessionApprovalGroup {
  sessionId: string;
  sessionName: string;
  approvals: ApprovalRequest[];
}

type TrackedAgent = {
  id: string;
  name: string;
  status: AgentSession['status'] | string;
  dashboardId?: string;
};

const STATUS_CONFIG: Record<string, { color: string; label: string; tokenKey?: string }> = {
  running:          { color: '', label: 'Running',  tokenKey: 'success' },
  waiting_approval: { color: '', label: 'Waiting',  tokenKey: 'warning' },
  completed:        { color: '', label: 'Done',     tokenKey: 'success' },
  error:            { color: '', label: 'Error',    tokenKey: 'error' },
  stopped:          { color: '', label: 'Stopped',  tokenKey: 'info' },
};

const StatusDot: React.FC<{ status: string; c: ReturnType<typeof useClaudeTokens> }> = ({ status, c }) => {
  const cfg = STATUS_CONFIG[status];
  const color = cfg?.tokenKey ? (c.status as any)[cfg.tokenKey] : c.text.ghost;
  const isActive = status === 'running';
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        bgcolor: color,
        flexShrink: 0,
        ...(isActive && {
          animation: 'agentPulse 1.8s ease-in-out infinite',
          '@keyframes agentPulse': {
            '0%, 100%': { opacity: 1, transform: 'scale(1)' },
            '50%': { opacity: 0.5, transform: 'scale(1.3)' },
          },
        }),
      }}
    />
  );
};

const AgentStatusRow: React.FC<{
  agent: TrackedAgent;
  c: ReturnType<typeof useClaudeTokens>;
  onStop: (id: string) => void;
  onDismiss: (id: string) => void;
  onNavigate: (dashboardId: string) => void;
}> = ({ agent, c, onStop, onDismiss, onNavigate }) => {
  const isActive = agent.status === 'running' || agent.status === 'waiting_approval';
  const cfg = STATUS_CONFIG[agent.status] ?? { label: agent.status };

  return (
    <Box
      onClick={() => agent.dashboardId && onNavigate(agent.dashboardId)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 0.75,
        cursor: agent.dashboardId ? 'pointer' : 'default',
        '&:hover': { bgcolor: `${c.text.ghost}10` },
        transition: 'background-color 0.15s',
        minHeight: 36,
      }}
    >
      <StatusDot status={agent.status} c={c} />
      <Typography
        sx={{
          fontSize: '0.8rem',
          fontWeight: 500,
          color: c.text.primary,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {agent.name}
      </Typography>
      <Typography
        sx={{
          fontSize: '0.65rem',
          color: c.text.ghost,
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
          flexShrink: 0,
        }}
      >
        {cfg.label}
      </Typography>
      {isActive ? (
        <Tooltip title="Stop agent" arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onStop(agent.id); }}
            sx={{ p: 0.25, color: c.status.error, '&:hover': { bgcolor: `${c.status.error}15` } }}
          >
            <StopCircleOutlinedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title="Dismiss" arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onDismiss(agent.id); }}
            sx={{ p: 0.25, color: c.text.ghost, '&:hover': { bgcolor: `${c.text.ghost}15` } }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
};

const GlobalApprovalOverlay: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const sessions = useAppSelector((state) => state.agents.sessions);
  const history = useAppSelector((state) => state.agents.history);
  const trackedIds = useAppSelector((state) => state.agents.trackedNotificationIds);
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

  const trackedAgents: TrackedAgent[] = useMemo(() => {
    return trackedIds
      .map((id): TrackedAgent | null => {
        const session = sessions[id];
        if (session && session.status !== 'draft') {
          return { id, name: session.name, status: session.status, dashboardId: session.dashboard_id };
        }
        const hist: HistorySession | undefined = history[id];
        if (hist) {
          return { id, name: hist.name, status: hist.status, dashboardId: hist.dashboard_id };
        }
        return null;
      })
      .filter((a): a is TrackedAgent => a !== null);
  }, [trackedIds, sessions, history]);

  const activeAgents = useMemo(
    () => trackedAgents.filter((a) => a.status === 'running' || a.status === 'waiting_approval'),
    [trackedAgents],
  );
  const finishedAgents = useMemo(
    () => trackedAgents.filter((a) => a.status !== 'running' && a.status !== 'waiting_approval'),
    [trackedAgents],
  );

  const totalBadge = totalApprovals + activeAgents.length;

  useEffect(() => {
    if (totalApprovals > 0 || activeAgents.length > 0) {
      setCollapsed(false);
    }
  }, [totalApprovals, activeAgents.length]);

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

  const onStopAgent = useCallback(
    (sessionId: string) => {
      dispatch(stopAgent({ sessionId }));
    },
    [dispatch],
  );

  const onDismissAgent = useCallback(
    (sessionId: string) => {
      dispatch(dismissAgentNotification(sessionId));
    },
    [dispatch],
  );

  const onNavigateToDashboard = useCallback(
    (dashboardId: string) => {
      navigate(`/dashboard/${dashboardId}`);
    },
    [navigate],
  );

  if (totalApprovals === 0 && trackedAgents.length === 0) return null;

  const hasApprovals = totalApprovals > 0;
  const hasAgents = trackedAgents.length > 0;
  const headerTitle = hasApprovals && !hasAgents
    ? 'Approval Required'
    : hasAgents && !hasApprovals
      ? 'Agents'
      : 'Notifications';
  const headerColor = hasApprovals ? c.status.warning : c.status.info;
  const headerBg = hasApprovals ? c.status.warningBg : c.status.infoBg;

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
        border: `1px solid ${headerColor}40`,
        boxShadow: `0 8px 32px rgba(0,0,0,0.25), 0 0 0 1px ${headerColor}20`,
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
          bgcolor: headerBg,
          borderBottom: collapsed ? 'none' : `1px solid ${headerColor}20`,
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: `${headerColor}18` },
          transition: 'background-color 0.15s',
        }}
      >
        <NotificationsActiveIcon
          sx={{
            fontSize: 18,
            color: headerColor,
            animation: hasApprovals ? 'approvalBell 0.6s ease-in-out' : 'none',
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
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: headerColor, flex: 1 }}>
          {headerTitle}
        </Typography>
        {totalBadge > 0 && (
          <Chip
            label={totalBadge}
            size="small"
            sx={{
              height: 22,
              minWidth: 28,
              fontSize: '0.75rem',
              fontWeight: 700,
              bgcolor: `${headerColor}20`,
              color: headerColor,
              border: 'none',
            }}
          />
        )}
        <IconButton size="small" sx={{ color: c.text.ghost, p: 0.25 }}>
          {collapsed ? <ExpandMoreIcon sx={{ fontSize: 18 }} /> : <ExpandLessIcon sx={{ fontSize: 18 }} />}
        </IconButton>
      </Box>

      {/* Content */}
      {!collapsed && (
        <Box
          sx={{
            overflow: 'auto',
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
          {/* Approvals section */}
          {hasApprovals && (
            <Box sx={{ py: 1 }}>
              {hasAgents && (
                <Typography
                  sx={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    color: c.text.ghost,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    px: 2,
                    pb: 0.5,
                  }}
                >
                  Approvals
                </Typography>
              )}
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

          {/* Divider between sections */}
          {hasApprovals && hasAgents && (
            <Box sx={{ mx: 2, borderTop: `1px solid ${c.border.light}` }} />
          )}

          {/* Agent status section */}
          {hasAgents && (
            <Box sx={{ py: 1 }}>
              {hasApprovals && (
                <Typography
                  sx={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    color: c.text.ghost,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    px: 2,
                    pb: 0.5,
                    pt: 0.5,
                  }}
                >
                  Agents
                </Typography>
              )}
              {activeAgents.map((agent) => (
                <AgentStatusRow
                  key={agent.id}
                  agent={agent}
                  c={c}
                  onStop={onStopAgent}
                  onDismiss={onDismissAgent}
                  onNavigate={onNavigateToDashboard}
                />
              ))}
              {finishedAgents.map((agent) => (
                <AgentStatusRow
                  key={agent.id}
                  agent={agent}
                  c={c}
                  onStop={onStopAgent}
                  onDismiss={onDismissAgent}
                  onNavigate={onNavigateToDashboard}
                />
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

export default GlobalApprovalOverlay;
