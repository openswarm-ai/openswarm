// The reusable top-right Share affordance. Drop it on any modality's surface.
// 'icon' is the Anthropic-style header icon; 'menuItem' is for a sidebar "..."
// overflow menu. Click always stops propagation so card/header parents that own
// their own onClick don't also fire.
import React, { useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import IosShareIcon from '@mui/icons-material/IosShare';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';

import ShareModal from './ShareModal';
import { ShareTarget } from './shareTypes';

interface Props {
  target: ShareTarget;
  size?: 'small' | 'medium';
  variant?: 'icon' | 'menuItem';
  tone?: 'plain' | 'chip'; // 'chip' matches floating card-action buttons
  iconFontSize?: number;
  onOpen?: () => void; // let a parent close its overflow menu when we take over
}

const ShareButton: React.FC<Props> = ({
  target,
  size = 'small',
  variant = 'icon',
  tone = 'plain',
  iconFontSize = 18,
  onOpen,
}) => {
  const c = useClaudeTokens();
  const [open, setOpen] = useState(false);

  const start = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen?.();
    setOpen(true);
  };

  const iconSx =
    tone === 'chip'
      ? { bgcolor: c.bg.surface, color: c.accent.primary, boxShadow: c.shadow.sm, '&:hover': { bgcolor: c.bg.elevated } }
      : { color: c.text.tertiary, '&:hover': { color: c.accent.primary } };

  return (
    <>
      {variant === 'menuItem' ? (
        <MenuItem onClick={start} sx={{ fontSize: '0.85rem', color: c.text.primary, gap: 1 }}>
          <ListItemIcon sx={{ minWidth: 0, color: c.text.tertiary }}>
            <IosShareIcon sx={{ fontSize: 16 }} />
          </ListItemIcon>
          Share
        </MenuItem>
      ) : (
        <Tooltip title="Share">
          <IconButton size={size} onClick={start} sx={iconSx}>
            <IosShareIcon sx={{ fontSize: iconFontSize }} />
          </IconButton>
        </Tooltip>
      )}
      {open && <ShareModal target={target} open={open} onClose={() => setOpen(false)} />}
    </>
  );
};

export default ShareButton;
