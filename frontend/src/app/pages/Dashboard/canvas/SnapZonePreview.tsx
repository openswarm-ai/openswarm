import React from 'react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { TILE_ZONES } from '@/app/pages/Dashboard/cards/tileZones';

// A translucent ghost of where a dragged card will land once released against the edge. Screen-space
// (fixed), so it lives outside the pan/zoom layer and never counter-transforms. 'fullscreen' fills
// the whole viewport; every other zone is a fraction of it.
const GAP = 8;

interface SnapZonePreviewProps {
  zone: string | null;
}

const SnapZonePreview: React.FC<SnapZonePreviewProps> = ({ zone }) => {
  const c = useClaudeTokens();
  if (!zone) return null;

  const vp = document.querySelector('[data-canvas-viewport]');
  const rect = vp ? vp.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const frac = zone === 'fullscreen' ? { x: 0, y: 0, w: 1, h: 1 } : TILE_ZONES[zone];
  if (!frac) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: rect.left + frac.x * rect.width + GAP,
        top: rect.top + frac.y * rect.height + GAP,
        width: frac.w * rect.width - GAP * 2,
        height: frac.h * rect.height - GAP * 2,
        borderRadius: 14,
        background: `${c.accent.primary}22`,
        border: `2px solid ${c.accent.primary}`,
        boxShadow: `0 0 0 100vmax ${c.accent.primary}0A`,
        pointerEvents: 'none',
        zIndex: 999985,
        transition: 'left 0.12s ease, top 0.12s ease, width 0.12s ease, height 0.12s ease',
      }}
    />
  );
};

export default SnapZonePreview;
