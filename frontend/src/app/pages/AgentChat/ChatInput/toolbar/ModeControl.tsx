import React from 'react';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

interface ModeConf { label: string; icon: React.ReactNode; color: string }

interface Props {
  c: ClaudeTokens;
  menuPaperProps: { sx: any };
  modeConf: ModeConf;
  modesArr: Array<{ id: string; name: string; icon: string; color: string }>;
  mode: string;
  onModeChange: (mode: string) => void;
  iconMap: Record<string, React.ReactNode>;
  modeAnchor: HTMLElement | null;
  setModeAnchor: (el: HTMLElement | null) => void;
  setModelAnchor: (el: HTMLElement | null) => void;
  allModelFlat: Array<any>;
  model: string;
}

export const ModeControl: React.FC<Props> = ({
  c, menuPaperProps, modeConf, modesArr, mode, onModeChange, iconMap, modeAnchor, setModeAnchor, setModelAnchor, allModelFlat, model,
}) => {
  return (
    <>
      <Box
        onClick={(e) => setModeAnchor(e.currentTarget)}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.375,
          borderRadius: '999px',
          cursor: 'pointer',
          userSelect: 'none',
          color: modeConf.color,
          bgcolor: `${modeConf.color}14`,
          '&:hover': { bgcolor: `${modeConf.color}22` },
          transition: 'background 0.15s',
        }}
      >
        {modeConf.icon}
        <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: 'inherit', lineHeight: 1 }}>
          {modeConf.label}
        </Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
      </Box>

      <Menu
        anchorEl={modeAnchor}
        open={Boolean(modeAnchor)}
        onClose={() => setModeAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: menuPaperProps }}
        autoFocus
        MenuListProps={{ autoFocusItem: true, disablePadding: false }}
      >
        {modesArr.map((m) => {
          const icon = iconMap[m.icon] || iconMap.smart_toy;
          return (
            <MenuItem
              key={m.id}
              selected={mode === m.id}
              onClick={() => {
                onModeChange(m.id);
                setModeAnchor(null);
              }}
            >
              <ListItemIcon sx={{ color: m.color, minWidth: 28 }}>
                {icon}
              </ListItemIcon>
              <ListItemText
                primary={m.name}
                slotProps={{ primary: { sx: { fontSize: '0.8rem', color: mode === m.id ? m.color : c.text.secondary } } }}
              />
            </MenuItem>
          );
        })}
      </Menu>

      <Box
        onClick={(e) => setModelAnchor(e.currentTarget)}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.75,
          py: 0.25,
          borderRadius: '6px',
          cursor: 'pointer',
          userSelect: 'none',
          color: c.text.muted,
          '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
          transition: 'background 0.15s',
        }}
      >
        <Typography sx={{ fontSize: '0.82rem', fontWeight: 500, color: 'inherit', lineHeight: 1 }}>
          {(() => { const m = allModelFlat.find((m) => m.value === model); return m ? m.label : model; })()}
        </Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
      </Box>
    </>
  );
};
