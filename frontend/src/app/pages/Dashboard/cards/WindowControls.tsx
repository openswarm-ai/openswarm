import React, { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import { TILE_ZONES } from './tileZones';

interface WindowControlsProps {
  onClose: () => void;
  onMinimize: () => void;
  onTile: (zone: string) => void; // a TILE_ZONES key, or 'restore'
  tiled?: boolean;
}

// macOS-style traffic lights on every card = the "AI OS" window feel. Grey at rest so a canvas
// full of cards isn't a wall of color; they colorize when the parent .osw-card is hovered, and the
// × – + symbols reveal on hovering the group. Hovering the GREEN dot opens the tiling menu (Fill,
// Halves, Quarters, Thirds), exactly like macOS; clicking green = Full Screen (or restore if tiled).
const RED = '#ff5f57';
const YELLOW = '#febc2e';
const GREEN = '#28c840';

const GROUPS: { label: string; zones: string[] }[] = [
  { label: 'Fill & Halves', zones: ['fill', 'left', 'right', 'top', 'bottom'] },
  { label: 'Quarters', zones: ['tl', 'tr', 'bl', 'br'] },
  { label: 'Thirds', zones: ['t3l', 't3c', 't3r'] },
];

const dotSx = (color: string): Record<string, unknown> => ({
  width: 12, height: 12, p: 0, m: 0, borderRadius: '50%', border: '0.5px solid rgba(0,0,0,0.06)',
  background: '#cccac4', cursor: 'pointer', position: 'relative', display: 'flex', alignItems: 'center',
  justifyContent: 'center', lineHeight: 1, transition: 'background 150ms',
  '.osw-card:hover &': { background: color },
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
  '.osw-pill-host:hover & .osw-window-lights > :nth-of-type(1)': { transform: 'translate(calc(-50% - 11px), calc(-50% + 5px)) scale(1)', opacity: 1 },
  '.osw-pill-host:hover & .osw-window-lights > :nth-of-type(2)': { transform: 'translate(-50%, calc(-50% - 7px)) scale(1)', opacity: 1, transitionDelay: '40ms' },
  '.osw-pill-host:hover & .osw-window-lights > :nth-of-type(3)': { transform: 'translate(calc(-50% + 11px), calc(-50% + 5px)) scale(1)', opacity: 1, transitionDelay: '80ms' },
};

function WindowControls({ onClose, onMinimize, onTile, tiled }: WindowControlsProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const openMenu = (): void => { if (closeTimer.current) window.clearTimeout(closeTimer.current); setMenuOpen(true); };
  const scheduleClose = (): void => { closeTimer.current = window.setTimeout(() => setMenuOpen(false), 180); };
  const stop = (e: React.PointerEvent | React.MouseEvent): void => { e.stopPropagation(); };

  const btn = (color: string, symbol: string, onClick: () => void, label: string): React.ReactElement => (
    <Box component="button" type="button" aria-label={label}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClick(); }} onPointerDown={stop} sx={dotSx(color)}>
      <span>{symbol}</span>
    </Box>
  );

  return (
    <Box className="osw-window-lights" onPointerDown={stop}
      sx={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 'none', '&:hover span': { opacity: 1 } }}>
      {btn(RED, '×', onClose, 'Close')}
      {btn(YELLOW, '–', onMinimize, 'Minimize')}
      <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}
        onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
        <Box component="button" type="button" aria-label={tiled ? 'Exit Full Screen' : 'Full Screen'}
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onTile(tiled ? 'restore' : 'fullscreen'); }}
          onPointerDown={stop} sx={dotSx(GREEN)}>
          <span>{tiled ? '–' : '+'}</span>
        </Box>
        <Box className="osw-tilemenu" onPointerDown={stop} onClick={stop}
          onMouseEnter={openMenu} onMouseLeave={scheduleClose}
          sx={{
            position: 'absolute', top: 19, left: -8, width: 216, background: '#FFFFFF',
            border: '1px solid rgba(0,0,0,0.06)', borderRadius: '12px', boxShadow: '0 .5rem 2rem rgba(0,0,0,.14)',
            p: 1.25, zIndex: 1200, transformOrigin: 'top left',
            opacity: menuOpen ? 1 : 0, transform: menuOpen ? 'none' : 'translateY(-6px) scale(0.96)',
            pointerEvents: menuOpen ? 'auto' : 'none', transition: 'opacity .16s, transform .18s cubic-bezier(.3,.9,.3,1)',
          }}>
          {GROUPS.map((g) => (
            <Box key={g.label} sx={{ mb: 0.75, '&:last-of-type': { mb: 0 } }}>
              <Box sx={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(115,114,108,0.65)', textTransform: 'uppercase', mb: 0.5 }}>{g.label}</Box>
              <Box sx={{ display: 'flex', gap: '7px' }}>
                {g.zones.map((zone) => {
                  const z = TILE_ZONES[zone];
                  return (
                    <Box key={zone} role="button" aria-label={zone}
                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); setMenuOpen(false); onTile(zone); }}
                      sx={{ position: 'relative', flex: 1, height: 32, border: '1px solid rgba(0,0,0,0.08)', borderRadius: '6px', background: '#F5F4ED', cursor: 'pointer', overflow: 'hidden', transition: 'border-color .12s, background .12s', '&:hover': { borderColor: '#ae5630', background: '#ae56300d' } }}>
                      <Box sx={{ position: 'absolute', left: `${z.x * 100 + 8}%`, top: `${z.y * 100 + 14}%`, width: `${z.w * 100 - 16}%`, height: `${z.h * 100 - 28}%`, background: '#ae5630', opacity: 0.8, borderRadius: '2px' }} />
                    </Box>
                  );
                })}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

export default WindowControls;
