import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { AgentStatusRow } from './AgentStatusRow';
import type { ClaudeTokens, TrackedAgent } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export const CompletedAgentsList: React.FC<{
  c: ClaudeTokens;
  finishedAgents: TrackedAgent[];
  showDivider: boolean;
  onStopAgent: (id: string) => void;
  onDismissAgent: (id: string) => void;
  onNavigateToDashboard: (dashboardId: string, agentId: string) => void;
  onClearAllFinished: () => void;
}> = ({ c, finishedAgents, showDivider, onStopAgent, onDismissAgent, onNavigateToDashboard, onClearAllFinished }) => {
  const [completedExpanded, setCompletedExpanded] = useState(false);

  if (finishedAgents.length === 0) return null;

  return (
    <>
      {showDivider && (
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
  );
};
