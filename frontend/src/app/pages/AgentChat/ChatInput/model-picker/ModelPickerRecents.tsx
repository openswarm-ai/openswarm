import React from 'react';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

interface Props {
  c: ClaudeTokens;
  model: string;
  onModelChange: (model: string) => void;
  pushRecentModel: (value: string) => void;
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (prov: string, currentlyCollapsed: boolean) => void;
  recentMaterialised: Array<any>;
  setModelAnchor: (el: HTMLElement | null) => void;
  buildModelTooltip: (opt: any) => React.ReactNode;
  tooltipSlotProps: any;
}

export const ModelPickerRecents: React.FC<Props> = ({
  c, model, onModelChange, pushRecentModel, collapsedGroups, toggleGroupCollapse,
  recentMaterialised, setModelAnchor, buildModelTooltip, tooltipSlotProps,
}) => {
  const recentKey = 'Recent';
  const recentCollapsed = !!collapsedGroups[recentKey];
  return (
    <>
      <MenuItem
        onClick={(e) => {
          e.stopPropagation();
          toggleGroupCollapse(recentKey, recentCollapsed);
        }}
        sx={{
          opacity: '1 !important',
          py: 0.75, px: 1.5, minHeight: 'auto',
          cursor: 'pointer',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: '100%' }}>
          <KeyboardArrowRightIcon
            sx={{
              fontSize: 14, color: c.text.tertiary,
              transform: recentCollapsed ? 'none' : 'rotate(90deg)',
              transition: 'transform 0.15s',
            }}
          />
          <AccessTimeIcon sx={{ fontSize: 12, color: c.text.tertiary }} />
          <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: c.text.tertiary, flex: 1 }}>
            Recent
          </Typography>
          <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, fontWeight: 500 }}>
            {recentMaterialised.length}
          </Typography>
        </Box>
      </MenuItem>
      <Collapse in={!recentCollapsed} timeout={180} unmountOnExit>
        {recentMaterialised.map((opt: any) => (
          <Tooltip
            key={`recent-${opt.value}`}
            title={buildModelTooltip(opt)}
            placement="right"
            enterDelay={300}
            slotProps={tooltipSlotProps}
          >
            <MenuItem
              selected={model === opt.value}
              onClick={() => {
                onModelChange(opt.value);
                pushRecentModel(opt.value);
                setModelAnchor(null);
              }}
            >
              <ListItemText
                primary={opt.label}
                slotProps={{ primary: { sx: { fontSize: '0.8rem', color: model === opt.value ? c.text.primary : c.text.muted } } }}
              />
            </MenuItem>
          </Tooltip>
        ))}
      </Collapse>
    </>
  );
};
