import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { motion } from 'framer-motion';
import { ApprovalRouter } from '@/app/pages/AgentChat/toolkit/approvalToolkit/ApprovalRouter';
import { BatchApprovalWrapper } from '@/app/pages/AgentChat/toolkit/approvalToolkit/BatchApprovalWrapper';
import { AgentStatusRow } from './AgentStatusRow';
import { CompletedAgentsList } from './CompletedAgentsList';
import type { ClaudeTokens, SessionApprovalGroup, TrackedAgent } from './islandTypes';

export const ExpandedCard: React.FC<{
  c: ClaudeTokens;
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
                  <BatchApprovalWrapper
                    requests={group.approvals}
                    onApprove={onApprove}
                    onDeny={onDeny}
                  />
                ) : (
                  group.approvals.map((req) => (
                    <ApprovalRouter
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
            <CompletedAgentsList
              c={c}
              finishedAgents={finishedAgents}
              showDivider={activeAgents.length > 0}
              onStopAgent={onStopAgent}
              onDismissAgent={onDismissAgent}
              onNavigateToDashboard={onNavigateToDashboard}
              onClearAllFinished={onClearAllFinished}
            />
          </Box>
        )}
      </Box>
    </motion.div>
  );
};
