import React, { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

export interface PlusMenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  // A toggle shows a check when active and stays open-able; an action fires and closes.
  toggle?: boolean;
  active?: boolean;
  // Quiet right-aligned text: a shortcut hint or a status ("2 active").
  hint?: string;
  // Claude-style flyout: a row with children opens a nested menu instead of firing onSelect.
  children?: PlusMenuItem[];
  onSelect: () => void;
}

// One "+" that holds every composer action so the bar reads empty at rest but has room to grow
// (the ChatGPT/Claude/Open WebUI grammar). Active toggles ALSO surface as a pill on the bar (see
// ActiveTogglePills) so their state is visible with the menu closed.
export const ComposerPlusMenu: React.FC<{ c: ClaudeTokens; items: PlusMenuItem[] }> = ({ c, items }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // One flyout at a time (Claude's grammar): hovering/clicking a parent row opens its submenu
  // anchored to the row; moving to a sibling row closes it.
  const [subFor, setSubFor] = useState<{ key: string; el: HTMLElement } | null>(null);
  const closeAll = (): void => { setSubFor(null); setAnchor(null); };
  if (items.length === 0) return null;

  const paperSx = {
    bgcolor: c.bg.surface,
    border: `1px solid ${c.border.subtle}`,
    borderRadius: '12px',
    minWidth: 208,
    boxShadow: c.shadow.lg,
    overflow: 'hidden',
  };

  const row = (it: PlusMenuItem, inSub: boolean): React.ReactElement => (
    <MenuItem
      key={it.key}
      onClick={(e) => {
        if (it.children) { setSubFor((prev) => (prev?.key === it.key ? null : { key: it.key, el: e.currentTarget as HTMLElement })); return; }
        it.onSelect();
        if (!it.toggle) closeAll();
      }}
      onMouseEnter={(e) => {
        if (it.children) setSubFor({ key: it.key, el: e.currentTarget as HTMLElement });
        else if (!inSub) setSubFor(null);
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
      {it.hint && (
        <Typography sx={{ fontSize: '0.6875rem', color: c.text.ghost, flexShrink: 0 }}>{it.hint}</Typography>
      )}
      {it.toggle && it.active && <CheckRoundedIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />}
      {it.children && <ChevronRightRoundedIcon sx={{ fontSize: 16, color: c.text.ghost, flexShrink: 0 }} />}
    </MenuItem>
  );

  const openSub = subFor ? items.find((it) => it.key === subFor.key) : null;

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
        onClose={closeAll}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { ...paperSx, mb: 0.5 } } }}
      >
        {items.map((it) => row(it, false))}
      </Menu>
      <Menu
        anchorEl={subFor?.el ?? null}
        open={!!subFor && !!openSub?.children?.length}
        onClose={() => setSubFor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        // The parent Menu already owns focus; a modal submenu would steal it and flicker.
        disableAutoFocus
        disableEnforceFocus
        hideBackdrop
        sx={{ pointerEvents: 'none' }}
        slotProps={{ paper: { sx: { ...paperSx, ml: 0.5, pointerEvents: 'auto', maxHeight: 320, overflowY: 'auto' } } }}
      >
        {(openSub?.children ?? []).map((child) => row(child, true))}
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
