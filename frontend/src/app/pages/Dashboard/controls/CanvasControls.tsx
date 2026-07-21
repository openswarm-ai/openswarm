import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import SpaceDashboardOutlinedIcon from '@mui/icons-material/SpaceDashboardOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MapIcon from '@mui/icons-material/Map';
import type { CanvasActions } from '../hooks/interaction/useCanvasControls';
import Minimap from './Minimap';
import type { MinimapProps } from './Minimap';

interface Props {
  zoom: number;
  actions: CanvasActions;
  onFitToView: () => void;
  onTidy: () => void;
  onDeleteSelected: () => void;
  hasSelection: boolean;
  minimapProps: Omit<MinimapProps, 'onPan'>;
  onMinimapPan: (panX: number, panY: number) => void;
}

// Default OFF: most users don't have enough cards for the minimap to add value; onboarding tip surfaces the toggle later.
const MINIMAP_PREF_KEY = 'openswarm.canvas.minimap_open';
function readMinimapPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MINIMAP_PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

const GLASS = 'rgba(22,12,34,0.66)';
const GLASS_BLUR = 'blur(20px) saturate(160%)';

const circleSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: '50%',
  background: GLASS,
  backdropFilter: GLASS_BLUR,
  WebkitBackdropFilter: GLASS_BLUR,
  boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
  color: 'rgba(255,255,255,0.72)',
  cursor: 'pointer',
  transition: 'color 0.15s',
  '&:hover': { color: '#fff' },
};

const CanvasControls: React.FC<Props> = ({ zoom, actions, onFitToView, onTidy, onDeleteSelected, hasSelection, minimapProps, onMinimapPan }) => {
  const pct = Math.round(zoom * 100);
  const [minimapOpen, setMinimapOpen] = useState<boolean>(() => readMinimapPref());
  const setAndPersistMinimap = (next: boolean) => {
    setMinimapOpen(next);
    try {
      window.localStorage.setItem(MINIMAP_PREF_KEY, String(next));
    } catch {
      /* private mode etc, not fatal */
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.75 }}>
      {minimapOpen && (
        <Box
          sx={{
            width: 200,
            height: 140,
            background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR,
            borderRadius: '12px',
            boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
            overflow: 'hidden',
          }}
        >
          <Minimap {...minimapProps} onPan={onMinimapPan} />
        </Box>
      )}

      <Tooltip title={minimapOpen ? 'Hide minimap' : 'Show minimap'} placement="left">
        <Box
          role="button"
          aria-label="Toggle minimap"
          onClick={() => setAndPersistMinimap(!minimapOpen)}
          data-onboarding="canvas-minimap-toggle"
          sx={{ ...circleSx, width: 26, height: 26, borderRadius: '8px', ...(minimapOpen && { color: '#fff' }) }}
        >
          <MapIcon sx={{ fontSize: 14 }} />
        </Box>
      </Tooltip>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }} data-onboarding="canvas-controls">
        <Tooltip title="Tidy layout" placement="top">
          <Box role="button" aria-label="Tidy layout" onClick={onTidy} data-onboarding="canvas-tidy-layout" sx={circleSx}>
            <SpaceDashboardOutlinedIcon sx={{ fontSize: 15 }} />
          </Box>
        </Tooltip>

        <Tooltip title={hasSelection ? 'Close selected' : 'Select a card to close it'} placement="top">
          <Box
            role="button"
            aria-label="Close selected"
            onClick={() => { if (hasSelection) onDeleteSelected(); }}
            sx={{ ...circleSx, ...(!hasSelection && { color: 'rgba(255,255,255,0.35)', cursor: 'default', '&:hover': { color: 'rgba(255,255,255,0.35)' } }) }}
          >
            <DeleteOutlineIcon sx={{ fontSize: 15 }} />
          </Box>
        </Tooltip>

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            height: 30,
            px: 1,
            borderRadius: 999,
            background: GLASS,
            backdropFilter: GLASS_BLUR,
            WebkitBackdropFilter: GLASS_BLUR,
            boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
            userSelect: 'none',
          }}
        >
          <Tooltip title="Zoom out" placement="top">
            <Box role="button" aria-label="Zoom out" onClick={actions.zoomOut} sx={{ display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', '&:hover': { color: '#fff' } }}>
              <RemoveIcon sx={{ fontSize: 15 }} />
            </Box>
          </Tooltip>

          <Tooltip title="Fit to view" placement="top">
            <Typography
              onClick={onFitToView}
              data-onboarding="canvas-fit-to-view"
              sx={{
                fontSize: '0.72rem',
                fontWeight: 500,
                color: 'rgba(255,255,255,0.78)',
                minWidth: 38,
                textAlign: 'center',
                cursor: 'pointer',
                lineHeight: 1,
                '&:hover': { color: '#fff' },
              }}
            >
              {pct}%
            </Typography>
          </Tooltip>

          <Tooltip title="Zoom in" placement="top">
            <Box role="button" aria-label="Zoom in" onClick={actions.zoomIn} sx={{ display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', '&:hover': { color: '#fff' } }}>
              <AddIcon sx={{ fontSize: 15 }} />
            </Box>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  );
};

export default CanvasControls;
