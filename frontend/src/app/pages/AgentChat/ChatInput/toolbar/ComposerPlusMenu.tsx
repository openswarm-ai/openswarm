import React, { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

export interface PlusMenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  // A toggle shows a check when active and stays open-able; an action fires and closes.
  toggle?: boolean;
  active?: boolean;
  onSelect: () => void;
}

// One "+" that holds every composer action so the bar reads empty at rest but has room to grow
// (the ChatGPT/Claude/Open WebUI grammar). Active toggles ALSO surface as a pill on the bar (see
// ActiveTogglePills) so their state is visible with the menu closed.
export const ComposerPlusMenu: React.FC<{ c: ClaudeTokens; items: PlusMenuItem[] }> = ({ c, items }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <Tooltip title="Add">
        <IconButton
          size="small"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => setAnchor(e.currentTarget)}
          data-onboarding="composer-plus"
          sx={{
            p: 0.5,
            color: anchor ? c.text.secondary : c.text.tertiary,
            bgcolor: anchor ? 'rgba(0,0,0,0.04)' : 'transparent',
            '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
            transition: 'color 0.12s, background-color 0.12s',
          }}
        >
          <AddRoundedIcon sx={{ fontSize: 19 }} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: '12px',
              minWidth: 208,
              mb: 0.5,
              boxShadow: c.shadow.lg,
              overflow: 'hidden',
            },
          },
        }}
      >
        {items.map((it) => (
          <MenuItem
            key={it.key}
            onClick={() => {
              it.onSelect();
              if (!it.toggle) setAnchor(null);
            }}
            sx={{
              py: 0.9,
              px: 1.5,
              gap: 1.25,
              display: 'flex',
              alignItems: 'center',
              color: it.active ? c.accent.primary : c.text.secondary,
              '&:hover': { bgcolor: c.bg.secondary },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', color: 'inherit', flexShrink: 0 }}>{it.icon}</Box>
            <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500, color: 'inherit', flex: 1 }}>{it.label}</Typography>
            {it.toggle && it.active && <CheckRoundedIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

// The active toggles as compact pills on the bar, so the mode is visible + one-click-off without
// reopening the menu. Empty when nothing is active, so the resting bar stays minimal.
export const ActiveTogglePills: React.FC<{ c: ClaudeTokens; items: PlusMenuItem[] }> = ({ c, items }) => {
  const active = items.filter((it) => it.toggle && it.active);
  if (active.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 1, minWidth: 0 }}>
      {active.map((it) => (
        <Tooltip key={it.key} title={`${it.label}: on. Click to turn off.`}>
          <Box
            role="button"
            onClick={it.onSelect}
            onMouseDown={(e) => e.preventDefault()}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              height: 24,
              pl: 0.75,
              pr: 0.9,
              borderRadius: 999,
              cursor: 'pointer',
              bgcolor: `${c.accent.primary}1f`,
              color: c.accent.primary,
              border: `1px solid ${c.accent.primary}33`,
              '&:hover': { bgcolor: `${c.accent.primary}2e` },
              transition: 'background-color 0.12s',
              '& svg': { fontSize: 14 },
              // Icon at rest, X on hover: the remove affordance without a permanent close button.
              '& .osw-pill-x': { display: 'none' },
              '&:hover .osw-pill-icon': { display: 'none' },
              '&:hover .osw-pill-x': { display: 'inline-flex' },
            }}
          >
            <Box component="span" className="osw-pill-icon" sx={{ display: 'inline-flex' }}>{it.icon}</Box>
            <Box component="span" className="osw-pill-x" sx={{ alignItems: 'center' }}><CloseRoundedIcon /></Box>
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: 'inherit', whiteSpace: 'nowrap' }}>
              {it.label}
            </Typography>
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
};
