import React, { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import SearchIcon from '@mui/icons-material/Search';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  handleApproval,
  stopAgent,
  dismissAgentNotification,
  dismissAllFinishedNotifications,
  ApprovalRequest,
  AgentSession,
  HistorySession,
} from '@/shared/state/agentsSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import ApprovalBar, { BatchApprovalBar, parseMcpToolName, useMcpToolMeta, getToolIcon } from '@/app/pages/AgentChat/ApprovalBar';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IslandState = 'idle' | 'compact' | 'compact-actionable' | 'expanded';

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

const STATUS_CONFIG: Record<string, { label: string; tokenKey?: string }> = {
  running:          { label: 'Running',  tokenKey: 'success' },
  waiting_approval: { label: 'Waiting',  tokenKey: 'warning' },
  completed:        { label: 'Done',     tokenKey: 'success' },
  error:            { label: 'Error',    tokenKey: 'error' },
  stopped:          { label: 'Stopped',  tokenKey: 'info' },
};

// ---------------------------------------------------------------------------
// Spring configs
// ---------------------------------------------------------------------------

const SPRING_LAYOUT = { type: 'spring' as const, stiffness: 400, damping: 30 };
const SPRING_BOUNCE = { type: 'spring' as const, stiffness: 500, damping: 25 };

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const StatusDot: React.FC<{ status: string; c: ReturnType<typeof useClaudeTokens> }> = ({ status, c }) => {
  const cfg = STATUS_CONFIG[status];
  const color = cfg?.tokenKey ? (c.status as any)[cfg.tokenKey] : c.text.ghost;
  const isActive = status === 'running';
  return (
    <Box
      sx={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        bgcolor: color,
        flexShrink: 0,
        opacity: 0.8,
        ...(isActive && {
          animation: 'islandPulse 2s ease-in-out infinite',
          '@keyframes islandPulse': {
            '0%, 100%': { opacity: 0.8, transform: 'scale(1)' },
            '50%': { opacity: 0.4, transform: 'scale(1.3)' },
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
  onNavigate: (dashboardId: string, agentId: string) => void;
}> = ({ agent, c, onStop, onDismiss, onNavigate }) => {
  const isActive = agent.status === 'running' || agent.status === 'waiting_approval';
  const cfg = STATUS_CONFIG[agent.status] ?? { label: agent.status };

  return (
    <Box
      onClick={() => agent.dashboardId && onNavigate(agent.dashboardId, agent.id)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 0.75,
        cursor: agent.dashboardId ? 'pointer' : 'default',
        '&:hover': { bgcolor: c.border.subtle },
        transition: 'background-color 0.15s',
        minHeight: 34,
      }}
    >
      <StatusDot status={agent.status} c={c} />
      <Typography
        sx={{
          fontSize: '0.78rem',
          fontWeight: 500,
          color: c.text.secondary,
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
          fontSize: '0.6rem',
          color: c.text.ghost,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
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
            sx={{ p: 0.25, color: c.text.ghost, '&:hover': { color: c.status.error, bgcolor: c.border.subtle } }}
          >
            <StopCircleOutlinedIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title="Dismiss" arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onDismiss(agent.id); }}
            sx={{ p: 0.25, color: c.text.ghost, '&:hover': { bgcolor: c.border.subtle } }}
          >
            <CloseIcon sx={{ fontSize: 13 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Compact activity indicator — subtle breathing dot
// ---------------------------------------------------------------------------

const ActivityIndicator: React.FC<{ c: ReturnType<typeof useClaudeTokens> }> = ({ c }) => (
  <Box
    sx={{
      width: 6,
      height: 6,
      borderRadius: '50%',
      bgcolor: c.text.tertiary,
      flexShrink: 0,
      animation: 'subtlePulse 2.2s ease-in-out infinite',
      '@keyframes subtlePulse': {
        '0%, 100%': { opacity: 0.6, transform: 'scale(1)' },
        '50%': { opacity: 1, transform: 'scale(1.15)' },
      },
    }}
  />
);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const DynamicIsland: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const islandRef = useRef<HTMLDivElement>(null);

  const sessions = useAppSelector((state) => state.agents.sessions);
  const history = useAppSelector((state) => state.agents.history);
  const trackedIds = useAppSelector((state) => state.agents.trackedNotificationIds);

  const [userExpanded, setUserExpanded] = useState(false);

  // ---- Derived data ----

  const groups: SessionApprovalGroup[] = useMemo(() => {
    const result: SessionApprovalGroup[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.pending_approvals?.length > 0) {
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
    const agents = trackedIds
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

    const trackedIdSet = new Set(trackedIds);
    for (const g of groups) {
      if (!trackedIdSet.has(g.sessionId)) {
        const session = sessions[g.sessionId];
        if (session && session.status !== 'draft') {
          agents.push({ id: g.sessionId, name: session.name, status: session.status, dashboardId: session.dashboard_id });
        }
      }
    }

    return agents;
  }, [trackedIds, sessions, history, groups]);

  const activeAgents = useMemo(
    () => trackedAgents.filter((a) => a.status === 'running' || a.status === 'waiting_approval'),
    [trackedAgents],
  );
  const finishedAgents = useMemo(
    () => trackedAgents.filter((a) => a.status !== 'running' && a.status !== 'waiting_approval'),
    [trackedAgents],
  );

  const hasApprovals = totalApprovals > 0;
  const hasAgents = trackedAgents.length > 0;

  const hasOnlyQuestionApprovals = useMemo(() => {
    if (!hasApprovals) return false;
    const allApprovals = groups.flatMap((g) => g.approvals);
    return allApprovals.every((a) => a.tool_name === 'AskUserQuestion');
  }, [hasApprovals, groups]);

  const nonQuestionApprovalCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.approvals.filter((a) => a.tool_name !== 'AskUserQuestion').length, 0),
    [groups],
  );

  const oldestNonQuestionApproval = useMemo(() => {
    const all = groups
      .flatMap((g) => g.approvals)
      .filter((a) => a.tool_name !== 'AskUserQuestion');
    if (all.length === 0) return null;
    return all.reduce((oldest, a) =>
      a.created_at < oldest.created_at ? a : oldest,
    );
  }, [groups]);

  // ---- Island state machine ----

  const islandState: IslandState = useMemo(() => {
    if (userExpanded && (hasAgents || hasApprovals)) return 'expanded';
    if (hasApprovals && hasOnlyQuestionApprovals) return 'expanded';
    if (hasApprovals) return 'compact-actionable';
    if (hasAgents) return 'compact';
    return 'idle';
  }, [hasApprovals, hasOnlyQuestionApprovals, userExpanded, hasAgents]);

  useEffect(() => {
    if (!hasAgents && !hasApprovals) {
      setUserExpanded(false);
    }
  }, [hasAgents, hasApprovals]);

  // ---- Click outside to collapse ----

  useEffect(() => {
    if (islandState !== 'expanded') return;
    const handler = (e: MouseEvent) => {
      if (islandRef.current && !islandRef.current.contains(e.target as Node)) {
        setUserExpanded(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [islandState]);

  // ---- Callbacks ----

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
    (sessionId: string) => dispatch(stopAgent({ sessionId })),
    [dispatch],
  );

  const onDismissAgent = useCallback(
    (sessionId: string) => dispatch(dismissAgentNotification(sessionId)),
    [dispatch],
  );

  const onNavigateToDashboard = useCallback(
    (dashboardId: string, agentId: string) => {
      dispatch(setPendingFocusAgentId(agentId));
      navigate(`/dashboard/${dashboardId}`);
    },
    [navigate, dispatch],
  );

  const onApproveAllNonQuestion = useCallback(() => {
    for (const g of groups) {
      for (const req of g.approvals) {
        if (req.tool_name !== 'AskUserQuestion') {
          dispatch(handleApproval({ requestId: req.id, behavior: 'allow' }));
        }
      }
    }
  }, [dispatch, groups]);

  const onDenyAllNonQuestion = useCallback(() => {
    for (const g of groups) {
      for (const req of g.approvals) {
        if (req.tool_name !== 'AskUserQuestion') {
          dispatch(handleApproval({ requestId: req.id, behavior: 'deny' }));
        }
      }
    }
  }, [dispatch, groups]);

  const onClearAllFinished = useCallback(() => {
    dispatch(dismissAllFinishedNotifications());
  }, [dispatch]);

  const handleIslandClick = useCallback(() => {
    if (islandState === 'compact' || islandState === 'compact-actionable') {
      setUserExpanded(true);
    } else if (islandState === 'expanded') {
      setUserExpanded(false);
    }
  }, [islandState]);

  // ---- Styling — uses the same neutral palette as the rest of the UI ----

  const islandWidth = islandState === 'idle'
    ? 200
    : islandState === 'compact'
      ? 210
      : islandState === 'compact-actionable'
        ? 310
        : 400;

  const islandBorderRadius = islandState === 'expanded' ? 14 : 50;

  const shadow = islandState === 'idle'
    ? 'none'
    : islandState === 'compact'
      ? c.shadow.sm
      : c.shadow.md;

  // ---- Compact summary text ----

  const compactText = useMemo(() => {
    const parts: string[] = [];
    if (activeAgents.length > 0) {
      parts.push(`${activeAgents.length} running`);
    }
    if (finishedAgents.length > 0) {
      parts.push(`${finishedAgents.length} done`);
    }
    return parts.join(' · ') || 'Agents';
  }, [activeAgents.length, finishedAgents.length]);

  const glowKeyframes = useMemo(() => `
    @keyframes approvalGlow {
      0%, 100% { box-shadow: 0 0 6px 1px ${c.status.warning}30; }
      50% { box-shadow: 0 0 12px 3px ${c.status.warning}60; }
    }
  `, [c.status.warning]);

  // ---- Render ----

  return (
    <>
    {islandState === 'compact-actionable' && <style>{glowKeyframes}</style>}
    <motion.div
      ref={islandRef}
      layout
      transition={islandState === 'expanded' ? SPRING_LAYOUT : SPRING_BOUNCE}
      style={{
        position: 'absolute',
        left: '50%',
        top: 6,
        x: '-50%',
        zIndex: 9999,
        width: islandWidth,
        borderRadius: islandBorderRadius,
        cursor: islandState === 'expanded' ? 'default' : 'pointer',
        // @ts-expect-error -- vendor prefix
        WebkitAppRegion: 'no-drag',
      }}
      onClick={islandState !== 'expanded' && islandState !== 'compact-actionable' ? handleIslandClick : undefined}
    >
      <motion.div
        layout
        transition={SPRING_LAYOUT}
        style={{
          background: c.bg.secondary,
          border: islandState === 'compact-actionable'
            ? `1px solid ${c.status.warning}`
            : `0.5px solid ${c.border.medium}`,
          borderRadius: islandBorderRadius,
          boxShadow: islandState === 'compact-actionable'
            ? `0 0 8px 1px ${c.status.warning}40`
            : shadow,
          overflow: 'hidden',
          animation: islandState === 'compact-actionable'
            ? 'approvalGlow 2.5s ease-in-out infinite'
            : 'none',
        }}
      >
        <AnimatePresence mode="wait">
          {islandState === 'idle' && (
            <IdlePill key="idle" c={c} />
          )}
          {islandState === 'compact' && (
            <CompactPill
              key="compact"
              c={c}
              text={compactText}
              activeCount={activeAgents.length}
              hasApprovals={hasApprovals}
            />
          )}
          {islandState === 'compact-actionable' && oldestNonQuestionApproval && (
            <CompactActionablePill
              key="compact-actionable"
              c={c}
              request={oldestNonQuestionApproval}
              remainingCount={nonQuestionApprovalCount}
              onApprove={onApprove}
              onDeny={onDeny}
              onExpand={() => setUserExpanded(true)}
            />
          )}
          {islandState === 'expanded' && (
            <ExpandedCard
              key="expanded"
              c={c}
              groups={groups}
              totalApprovals={totalApprovals}
              activeAgents={activeAgents}
              finishedAgents={finishedAgents}
              hasApprovals={hasApprovals}
              hasAgents={hasAgents}
              onApprove={onApprove}
              onDeny={onDeny}
              onStopAgent={onStopAgent}
              onDismissAgent={onDismissAgent}
              onNavigateToDashboard={onNavigateToDashboard}
              onClearAllFinished={onClearAllFinished}
              onCollapse={() => setUserExpanded(false)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Idle pill — disabled search bar
// ---------------------------------------------------------------------------

const IdlePill: React.FC<{ c: ReturnType<typeof useClaudeTokens> }> = ({ c }) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.92 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={{ duration: 0.2 }}
  >
    <Tooltip title="Coming soon" arrow placement="bottom">
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.25,
          height: 24,
          userSelect: 'none',
          cursor: 'default',
        }}
      >
        <SearchIcon sx={{ fontSize: 13, color: c.text.ghost, flexShrink: 0 }} />
        <Typography
          sx={{
            color: c.text.ghost,
            fontSize: '0.66rem',
            fontWeight: 400,
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          Search...
        </Typography>
      </Box>
    </Tooltip>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Compact pill
// ---------------------------------------------------------------------------

const CompactPill: React.FC<{
  c: ReturnType<typeof useClaudeTokens>;
  text: string;
  activeCount: number;
  hasApprovals: boolean;
}> = ({ c, text, activeCount, hasApprovals }) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.92 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={SPRING_BOUNCE}
  >
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.5,
        height: 24,
        userSelect: 'none',
      }}
    >
      <ActivityIndicator c={c} />
      <Typography
        sx={{
          fontSize: '0.68rem',
          fontWeight: 500,
          color: c.text.tertiary,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </Typography>
      {hasApprovals && (
        <Box
          sx={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            bgcolor: c.accent.primary,
            flexShrink: 0,
            opacity: 0.8,
          }}
        />
      )}
    </Box>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Compact-actionable pill — single approval with icon + name + approve/deny
// ---------------------------------------------------------------------------

const CompactActionablePill: React.FC<{
  c: ReturnType<typeof useClaudeTokens>;
  request: ApprovalRequest;
  remainingCount: number;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onExpand: () => void;
}> = ({ c, request, remainingCount, onApprove, onDeny, onExpand }) => {
  const parsed = useMemo(() => parseMcpToolName(request.tool_name), [request.tool_name]);
  const meta = useMcpToolMeta(parsed);

  const icon = parsed.isMcp
    ? (meta.integration?.icon || null)
    : getToolIcon(request.tool_name);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={SPRING_BOUNCE}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 0.5,
          height: 24,
          userSelect: 'none',
        }}
      >
        <Box
          sx={{
            width: 16,
            height: 16,
            borderRadius: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: c.text.tertiary,
            '& svg': { width: 12, height: 12 },
          }}
        >
          {icon}
        </Box>
        <Typography
          sx={{
            fontSize: '0.68rem',
            fontWeight: 600,
            color: c.text.secondary,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {parsed.displayName}
        </Typography>
        {remainingCount > 1 && (
          <Typography
            sx={{
              fontSize: '0.6rem',
              fontWeight: 600,
              color: c.text.ghost,
              flexShrink: 0,
            }}
          >
            +{remainingCount - 1}
          </Typography>
        )}
        <Tooltip title="Approve" arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onApprove(request.id); }}
            sx={{
              p: 0,
              width: 18,
              height: 18,
              color: '#fff',
              bgcolor: c.status.success,
              '&:hover': { bgcolor: c.status.success, filter: 'brightness(0.85)' },
            }}
          >
            <CheckIcon sx={{ fontSize: 11 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Deny" arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onDeny(request.id); }}
            sx={{
              p: 0,
              width: 18,
              height: 18,
              color: c.status.error,
              border: `1px solid ${c.status.error}`,
              '&:hover': { bgcolor: `${c.status.error}0a` },
            }}
          >
            <CloseIcon sx={{ fontSize: 11 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Show details" arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
            sx={{ p: 0.25, color: c.text.ghost, '&:hover': { color: c.text.tertiary } }}
          >
            <ExpandMoreIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Expanded card
// ---------------------------------------------------------------------------

const ExpandedCard: React.FC<{
  c: ReturnType<typeof useClaudeTokens>;
  groups: SessionApprovalGroup[];
  totalApprovals: number;
  activeAgents: TrackedAgent[];
  finishedAgents: TrackedAgent[];
  hasApprovals: boolean;
  hasAgents: boolean;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
  onStopAgent: (id: string) => void;
  onDismissAgent: (id: string) => void;
  onNavigateToDashboard: (dashboardId: string, agentId: string) => void;
  onClearAllFinished: () => void;
  onCollapse: () => void;
}> = ({
  c, groups, totalApprovals,
  activeAgents, finishedAgents, hasApprovals, hasAgents,
  onApprove, onDeny, onStopAgent, onDismissAgent, onNavigateToDashboard, onClearAllFinished, onCollapse,
}) => {
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const headerTitle = hasApprovals && !hasAgents
    ? 'Approval Required'
    : hasAgents && !hasApprovals
      ? 'Agents'
      : 'Notifications';

  const badgeCount = totalApprovals + activeAgents.length;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18 }}
    >
      {/* Header */}
      <Box
        onClick={!hasApprovals ? onCollapse : undefined}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1,
          cursor: hasApprovals ? 'default' : 'pointer',
          userSelect: 'none',
          borderBottom: `0.5px solid ${c.border.subtle}`,
          '&:hover': !hasApprovals ? { bgcolor: c.border.subtle } : {},
          transition: 'background-color 0.15s',
        }}
      >
        <Typography
          sx={{
            fontSize: '0.76rem',
            fontWeight: 600,
            color: c.text.muted,
            flex: 1,
          }}
        >
          {headerTitle}
        </Typography>
        {badgeCount > 0 && (
          <Typography
            sx={{
              fontSize: '0.65rem',
              fontWeight: 600,
              color: c.text.ghost,
              flexShrink: 0,
            }}
          >
            {badgeCount}
          </Typography>
        )}
        {!hasApprovals && (
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onCollapse(); }}
            sx={{ p: 0.25, color: c.text.ghost, '&:hover': { color: c.text.tertiary } }}
          >
            <CloseIcon sx={{ fontSize: 13 }} />
          </IconButton>
        )}
      </Box>

      {/* Content */}
      <Box
        sx={{
          overflow: 'auto',
          maxHeight: 'min(420px, calc(100vh - 100px))',
          '&::-webkit-scrollbar': { width: 4 },
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
        {hasApprovals && (
          <Box sx={{ py: 1 }}>
            {hasAgents && (
              <Typography
                sx={{
                  fontSize: '0.58rem',
                  fontWeight: 600,
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
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      color: c.text.ghost,
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

        {hasApprovals && hasAgents && (
          <Box sx={{ mx: 2, borderTop: `0.5px solid ${c.border.subtle}` }} />
        )}

        {hasAgents && (
          <Box sx={{ py: 0.75 }}>
            {hasApprovals && (
              <Typography
                sx={{
                  fontSize: '0.58rem',
                  fontWeight: 600,
                  color: c.text.ghost,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  px: 2,
                  pb: 0.5,
                  pt: 0.25,
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
            {finishedAgents.length > 0 && (
              <>
                {activeAgents.length > 0 && (
                  <Box sx={{ mx: 2, my: 0.5, borderTop: `0.5px solid ${c.border.subtle}` }} />
                )}
                <Box
                  onClick={() => setCompletedExpanded((v) => !v)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 2,
                    py: 0.5,
                    cursor: 'pointer',
                    userSelect: 'none',
                    '&:hover': { bgcolor: c.border.subtle },
                    transition: 'background-color 0.15s',
                  }}
                >
                  <Typography
                    sx={{
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      color: c.text.ghost,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      flex: 1,
                    }}
                  >
                    Completed ({finishedAgents.length})
                  </Typography>
                  <Typography
                    component="span"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClearAllFinished(); }}
                    sx={{
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      color: c.text.ghost,
                      cursor: 'pointer',
                      '&:hover': { color: c.text.secondary },
                      transition: 'color 0.15s',
                    }}
                  >
                    Clear all
                  </Typography>
                  <IconButton size="small" sx={{ p: 0, color: c.text.ghost }}>
                    {completedExpanded
                      ? <ExpandLessIcon sx={{ fontSize: 14 }} />
                      : <ExpandMoreIcon sx={{ fontSize: 14 }} />}
                  </IconButton>
                </Box>
                <Collapse in={completedExpanded}>
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
                </Collapse>
              </>
            )}
          </Box>
        )}
      </Box>
    </motion.div>
  );
};

export default DynamicIsland;
