import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { StatusDot } from './StatusDot';
import { STATUS_CONFIG } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';
import type { ClaudeTokens, TrackedAgent } from '@/app/components/AppShell/components/TitleBar/DynamicIsland/islandTypes';

export const AgentStatusRow: React.FC<{
  agent: TrackedAgent;
  c: ClaudeTokens;
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
