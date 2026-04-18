import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { motion } from 'framer-motion';
import { parseMcpToolName, getToolIcon } from '@/app/pages/AgentChat/toolkit/approval-utils';
import { useMcpToolMeta } from '@/app/pages/AgentChat/toolkit/approval-tools';
import { SPRING_BOUNCE } from './islandTypes';
import type { ClaudeTokens } from './islandTypes';
import type { ApprovalRequest } from '@/shared/state/agentsSlice';

export const CompactActionablePill: React.FC<{
  c: ClaudeTokens;
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
