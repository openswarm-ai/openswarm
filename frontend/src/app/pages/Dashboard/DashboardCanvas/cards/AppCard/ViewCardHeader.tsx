import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import RefreshIcon from '@mui/icons-material/Refresh';
import BoltIcon from '@mui/icons-material/Bolt';
import CloseIcon from '@mui/icons-material/Close';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface ViewCardHeaderProps {
  name: string;
  hasAutoRun: boolean;
  autoRunning: boolean;
  isDragging: boolean;
  onDragPointerDown: (e: React.PointerEvent) => void;
  onDragPointerMove: (e: React.PointerEvent) => void;
  onDragPointerUp: (e: React.PointerEvent) => void;
  onRefresh: (e: React.MouseEvent) => void;
  onAutoRun: (e: React.MouseEvent) => void;
  onRemove: (e: React.MouseEvent) => void;
}

const ViewCardHeader: React.FC<ViewCardHeaderProps> = ({
  name, hasAutoRun, autoRunning, isDragging,
  onDragPointerDown, onDragPointerMove, onDragPointerUp,
  onRefresh, onAutoRun, onRemove,
}) => {
  const c = useClaudeTokens();

  return (
    <Box
      onPointerDown={onDragPointerDown}
      onPointerMove={onDragPointerMove}
      onPointerUp={onDragPointerUp}
      sx={{
        position: 'relative',
        zIndex: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.5,
        py: 0.75,
        bgcolor: c.bg.secondary,
        borderBottom: `1px solid ${c.border.subtle}`,
        cursor: isDragging ? 'grabbing' : 'grab',
        flexShrink: 0,
        minHeight: 36,
        userSelect: 'none',
      }}
    >
      <GridViewRoundedIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
      <Typography
        sx={{
          flex: 1,
          fontSize: '0.8rem',
          fontWeight: 600,
          color: c.text.primary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </Typography>

      <Tooltip title="Reload preview" placement="top">
        <IconButton
          size="small"
          onClick={onRefresh}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ color: c.text.muted, p: 0.5, '&:hover': { color: c.text.primary } }}
        >
          <RefreshIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>

      {hasAutoRun && (
        <Tooltip title={autoRunning ? 'Running...' : 'Auto Run'} placement="top">
          <span>
            <IconButton
              size="small"
              onClick={onAutoRun}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={autoRunning}
              sx={{ color: '#f59e0b', p: 0.5, '&:hover': { color: '#d97706' } }}
            >
              {autoRunning ? <CircularProgress size={14} sx={{ color: '#f59e0b' }} /> : <BoltIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </span>
        </Tooltip>
      )}

      <Tooltip title="Remove from dashboard" placement="top">
        <IconButton
          size="small"
          onClick={onRemove}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ color: c.text.ghost, p: 0.5, '&:hover': { color: c.status.error } }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default ViewCardHeader;
