import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import MapIcon from '@mui/icons-material/Map';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { CanvasActions } from './useCanvasControls';
import Minimap from './Minimap';
import type { MinimapProps } from './Minimap';

interface Props {
  zoom: number;
  actions: CanvasActions;
  onFitToView: () => void;
  onTidy: () => void;
  minimapProps: Omit<MinimapProps, 'onPan'>;
  onMinimapPan: (panX: number, panY: number) => void;
}

const CanvasControls: React.FC<Props> = ({ zoom, actions, onFitToView, onTidy, minimapProps, onMinimapPan }) => {
  const c = useClaudeTokens();
  const pct = Math.round(zoom * 100);
  const [minimapOpen, setMinimapOpen] = useState(true);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.75 }}>
      {/* Minimap panel — sits above the toolbar */}
      {minimapOpen && (
        <Box
          sx={{
            width: 200,
            height: 140,
            bgcolor: c.bg.surface,
            border: `1px solid ${c.border.medium}`,
            borderRadius: `${c.radius.lg}px`,
            boxShadow: c.shadow.md,
            overflow: 'hidden',
          }}
        >
          <Minimap {...minimapProps} onPan={onMinimapPan} />
        </Box>
      )}

      {/* Toolbar */}
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
          <IconButton size="small" onClick={onFitToView} sx={{ color: c.text.muted }}>
            <FitScreenIcon sx={{ fontSize: '1rem' }} />
          </IconButton>
        </Tooltip>

        <Tooltip title="Tidy layout" placement="top">
          <IconButton size="small" onClick={onTidy} sx={{ color: c.text.muted }}>
            <AutoAwesomeIcon sx={{ fontSize: '1rem' }} />
          </IconButton>
        </Tooltip>

        <Box sx={{ width: 1, height: 16, bgcolor: c.border.medium, mx: 0.5 }} />

        <Tooltip title={minimapOpen ? 'Hide minimap' : 'Show minimap'} placement="top">
          <IconButton
            size="small"
            onClick={() => setMinimapOpen((v) => !v)}
            sx={{ color: minimapOpen ? c.accent.primary : c.text.muted }}
          >
            <MapIcon sx={{ fontSize: '1rem' }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default CanvasControls;
