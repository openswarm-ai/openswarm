import React from 'react';
import Box from '@mui/material/Box';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  hasLeft: boolean;
  hasRight: boolean;
  hasUp: boolean;
  hasDown: boolean;
  shakeDirection: 'left' | 'right' | 'up' | 'down' | null;
}

const shakeKeyframes: Record<string, string> = {
  left: `
    @keyframes shake-left { 0%,100% { transform: translateY(-50%) translateX(0); } 25% { transform: translateY(-50%) translateX(-6px); } 75% { transform: translateY(-50%) translateX(4px); } }
  `,
  right: `
    @keyframes shake-right { 0%,100% { transform: translateY(-50%) translateX(0); } 25% { transform: translateY(-50%) translateX(6px); } 75% { transform: translateY(-50%) translateX(-4px); } }
  `,
  up: `
    @keyframes shake-up { 0%,100% { transform: translateX(-50%) translateY(0); } 25% { transform: translateX(-50%) translateY(-6px); } 75% { transform: translateX(-50%) translateY(4px); } }
  `,
  down: `
    @keyframes shake-down { 0%,100% { transform: translateX(-50%) translateY(0); } 25% { transform: translateX(-50%) translateY(6px); } 75% { transform: translateX(-50%) translateY(-4px); } }
  `,
};

const DirectionHints: React.FC<Props> = ({ hasLeft, hasRight, hasUp, hasDown, shakeDirection }) => {
  const c = useClaudeTokens();

  const hintSx = {
    position: 'absolute' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: '50%',
    bgcolor: c.bg.surface,
    border: `1px solid ${c.border.medium}`,
    boxShadow: c.shadow.sm,
    color: c.text.muted,
    opacity: 0.5,
    transition: 'opacity 0.2s',
    pointerEvents: 'none' as const,
  };

  const shakingSx = (dir: string) => ({
    ...hintSx,
    opacity: 1,
    color: c.accent.primary,
    animation: `shake-${dir} 0.3s ease 2`,
  });

  // Show shake indicator even when there's no neighbor in that direction
  const showLeft = hasLeft || shakeDirection === 'left';
  const showRight = hasRight || shakeDirection === 'right';
  const showUp = hasUp || shakeDirection === 'up';
  const showDown = hasDown || shakeDirection === 'down';

  return (
    <>
      {/* Inject shake keyframes */}
      {shakeDirection && (
        <style>{shakeKeyframes[shakeDirection]}</style>
      )}

      {showLeft && (
        <Box sx={{
          ...(shakeDirection === 'left' ? shakingSx('left') : hintSx),
          left: 16, top: '50%', transform: 'translateY(-50%)',
        }}>
          <ChevronLeftIcon sx={{ fontSize: '1.1rem' }} />
        </Box>
      )}
      {showRight && (
        <Box sx={{
          ...(shakeDirection === 'right' ? shakingSx('right') : hintSx),
          right: 16, top: '50%', transform: 'translateY(-50%)',
        }}>
          <ChevronRightIcon sx={{ fontSize: '1.1rem' }} />
        </Box>
      )}
      {showUp && (
        <Box sx={{
          ...(shakeDirection === 'up' ? shakingSx('up') : hintSx),
          top: 16, left: '50%', transform: 'translateX(-50%)',
        }}>
          <KeyboardArrowUpIcon sx={{ fontSize: '1.1rem' }} />
        </Box>
      )}
      {showDown && (
        <Box sx={{
          ...(shakeDirection === 'down' ? shakingSx('down') : hintSx),
          bottom: 56, left: '50%', transform: 'translateX(-50%)',
        }}>
          <KeyboardArrowDownIcon sx={{ fontSize: '1.1rem' }} />
        </Box>
      )}
    </>
  );
};

export default DirectionHints;
