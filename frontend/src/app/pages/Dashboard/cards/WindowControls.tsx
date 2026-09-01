import React from 'react';
import Box from '@mui/material/Box';

interface WindowControlsProps {
  onClose: () => void;
  onMinimize: () => void;
  onTile: (zone: string) => void; // 'fullscreen' or 'restore'
  tiled?: boolean;
  /** Onboarding anchor riding the close dot (the settings flow points its cursor here). */
  closeDataOnboarding?: string;
}

// macOS-style traffic lights on every card = the "AI OS" window feel. Grey at rest so a canvas
// full of cards isn't a wall of color; they colorize when the parent .osw-card is hovered, and the
// close/minus/plus symbols reveal on hovering the group. Clicking green = Full Screen (or restore if tiled).
const RED = '#ff5f57';
const YELLOW = '#febc2e';
const GREEN = '#28c840';

const dotSx = (color: string): Record<string, unknown> => ({
  width: 12, height: 12, p: 0, m: 0, borderRadius: '50%', border: '0.5px solid rgba(0,0,0,0.06)',
  background: '#cccac4', cursor: 'pointer', position: 'relative', display: 'flex', alignItems: 'center',
  justifyContent: 'center', lineHeight: 1, transition: 'background 150ms',
  '.osw-card:hover &, .osw-pill-lights:hover &': { background: color },
  '& > span': { fontSize: 9, fontWeight: 800, lineHeight: 1, color: 'rgba(0,0,0,0.5)', opacity: 0, transition: 'opacity 120ms', pointerEvents: 'none' },
});

// Circular chip form for minimized pills/thumbnails: the three dots collapse to a point and fan out
// along an arc on hover (OptionWheel / macOS-dock energy), instead of a flat row in a lozenge.
export const ARC_CHIP_SX: Record<string, unknown> = {
  width: 40,
  height: 40,
  borderRadius: 999,
  '& .osw-window-lights': { position: 'relative', width: '100%', height: '100%', display: 'block' },
  '& .osw-window-lights > *': {
    position: 'absolute', left: '50%', top: '50%',
    transform: 'translate(-50%, -50%) scale(0.35)', opacity: 0,
    transition: 'transform 190ms cubic-bezier(.3,.9,.3,1), opacity 150ms ease',
  },
  // red / yellow / green land at 150deg / 90deg / 30deg on a 12px arc over the chip's crown.
  // Keyed off the HOST (whole pill/thumb) hover, so grazing any part of it fans the dots out.
  // Addressed by data-light, never by position: green is a wrapper DIV among two BUTTONs, and the
  // old nth-of-type counted per tag, so it dealt green the red slot and parked it on top of Close.
  '.osw-pill-host:hover & .osw-window-lights > [data-light="close"]': { transform: 'translate(calc(-50% - 11px), calc(-50% + 5px)) scale(1)', opacity: 1 },
  '.osw-pill-host:hover & .osw-window-lights > [data-light="minimize"]': { transform: 'translate(-50%, calc(-50% - 7px)) scale(1)', opacity: 1, transitionDelay: '40ms' },
  '.osw-pill-host:hover & .osw-window-lights > [data-light="zoom"]': { transform: 'translate(calc(-50% + 11px), calc(-50% + 5px)) scale(1)', opacity: 1, transitionDelay: '80ms' },
};

function WindowControls({ onClose, onMinimize, onTile, tiled, closeDataOnboarding }: WindowControlsProps): React.ReactElement {
  const stop = (e: React.PointerEvent | React.MouseEvent): void => { e.stopPropagation(); };

  const btn = (color: string, symbol: string, onClick: () => void, label: string, slot: string): React.ReactElement => (
    <Box component="button" type="button" aria-label={label} data-light={slot}
      {...(slot === 'close' && closeDataOnboarding ? { 'data-onboarding': closeDataOnboarding } : {})}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClick(); }} onPointerDown={stop} sx={dotSx(color)}>
      <span>{symbol}</span>
    </Box>
  );

  return (
    <Box className="osw-window-lights" onPointerDown={stop}
      sx={{
        display: 'flex', gap: '8px', alignItems: 'center', flex: 'none', '&:hover span': { opacity: 1 },
        // Inert until the card is hovered: crossing a card can't hit-test or fire React enter/leave
        // through the dots, and you can't aim at a dot without hovering its card first anyway.
        pointerEvents: 'none', '.osw-card:hover &, .osw-pill-lights:hover &': { pointerEvents: 'auto' },
      }}>
      {btn(RED, '×', onClose, 'Close', 'close')}
      {btn(YELLOW, '−', onMinimize, 'Minimize', 'minimize')}
      <Box data-light="zoom" sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <Box component="button" type="button" aria-label={tiled ? 'Exit Full Screen' : 'Full Screen'}
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onTile(tiled ? 'restore' : 'fullscreen'); }}
          onPointerDown={stop} sx={dotSx(GREEN)}>
          <span>{tiled ? '−' : '+'}</span>
        </Box>
      </Box>
    </Box>
  );
}

export default WindowControls;
