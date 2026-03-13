import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { CanvasActions } from './useCanvasControls';

interface Props {
  zoom: number;
  actions: CanvasActions;
  onTidy: () => void;
}

const CanvasControls: React.FC<Props> = ({ zoom, actions, onTidy }) => {
  const c = useClaudeTokens();
  const pct = Math.round(zoom * 100);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.medium}`,
        borderRadius: `${c.radius.lg}px`,
        boxShadow: c.shadow.sm,
        py: 0.25,
        px: 0.5,
        userSelect: 'none',
      }}
    >
      <Tooltip title="Zoom out" placement="top">
        <IconButton size="small" onClick={actions.zoomOut} sx={{ color: c.text.muted }}>
          <RemoveIcon sx={{ fontSize: '1rem' }} />
        </IconButton>
      </Tooltip>

      <Tooltip title="Reset to 100%" placement="top">
        <Typography
          onClick={actions.resetZoom}
          sx={{
            fontSize: '0.75rem',
            fontWeight: 500,
            color: c.text.secondary,
            minWidth: 40,
            textAlign: 'center',
            cursor: 'pointer',
            lineHeight: 1,
            '&:hover': { color: c.text.primary },
          }}
        >
          {pct}%
        </Typography>
      </Tooltip>

      <Tooltip title="Zoom in" placement="top">
        <IconButton size="small" onClick={actions.zoomIn} sx={{ color: c.text.muted }}>
          <AddIcon sx={{ fontSize: '1rem' }} />
        </IconButton>
      </Tooltip>

      <Box sx={{ width: 1, height: 16, bgcolor: c.border.medium, mx: 0.5 }} />

      <Tooltip title="Fit to view" placement="top">
        <IconButton size="small" onClick={actions.fitToView} sx={{ color: c.text.muted }}>
          <FitScreenIcon sx={{ fontSize: '1rem' }} />
        </IconButton>
      </Tooltip>

      <Box sx={{ width: 1, height: 16, bgcolor: c.border.medium, mx: 0.5 }} />

      <Tooltip title="Tidy layout" placement="top">
        <IconButton size="small" onClick={onTidy} sx={{ color: c.text.muted }}>
          <AutoAwesomeIcon sx={{ fontSize: '1rem' }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default CanvasControls;
