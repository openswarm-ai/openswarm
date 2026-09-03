import React from 'react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { LABEL_FONT_PX, LABEL_MIN_ZOOM, type Tether } from '../geometry/dashboardTethers';

const TETHER_FADE_MS = 500;

interface TetherLayerProps {
  tethers: Tether[];
  zoom: number;
  c: ClaudeTokens;
}

const TetherLayer: React.FC<TetherLayerProps> = ({ tethers, zoom, c }) => {
  if (tethers.length === 0) return null;
  const showLabels = zoom >= LABEL_MIN_ZOOM;
  return (
    <svg
      data-canvas-overlay="1"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
        // Behind every card (cards use zOrder 1..N as their z-index): connector lines tuck UNDER the cards like a node graph, visible only in the gaps between them.
        zIndex: 0,
      }}
    >
      {tethers.map((t) => (
        <g
          key={t.key}
          data-tether={t.key}
          style={{
            opacity: t.fading ? 0 : 1,
            transition: `opacity ${TETHER_FADE_MS}ms ease-out`,
          }}
        >
          {/* The stroke is a non-scaling one: 1.5px on screen at every camera, where it used to shrink to a hairline zoomed out and fatten zoomed in. The halo is the spawn cue only; a steady link is a plain line. */}
          {t.glow && (
            <path d={t.path} fill="none" stroke={c.accent.primary} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" opacity={0.14} vectorEffect="non-scaling-stroke" />
          )}
          <path d={t.path} fill="none" stroke={c.accent.primary} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={t.glow ? 0.85 : 0.6} vectorEffect="non-scaling-stroke" />
          <path d={t.head} fill={c.accent.primary} opacity={t.glow ? 0.9 : 0.7} />
          {t.label && showLabels && (
            // Same glass capsule as the narrator pills, scaled against the camera so it reads at LABEL_FONT_PX whatever the zoom.
            <g transform={`translate(${t.labelX},${t.labelY}) scale(${t.labelScale})`}>
              <rect
                x={-(t.label.length * 7.5) / 2 - 6}
                y={-11}
                width={t.label.length * 7.5 + 12}
                height={22}
                rx={11}
                fill="rgba(24,14,32,0.85)"
              />
              <text x={0} y={4} textAnchor="middle" fontSize={LABEL_FONT_PX} fontWeight={600} fontFamily="inherit" fill="rgba(255,255,255,0.92)">
                {t.label}
              </text>
            </g>
          )}
        </g>
      ))}
    </svg>
  );
};

export default TetherLayer;
