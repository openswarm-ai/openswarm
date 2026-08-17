import React from 'react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { Tether } from '../geometry/dashboardTethers';

const TETHER_FADE_MS = 500;

interface TetherLayerProps {
  tethers: Tether[];
  c: ClaudeTokens;
}

const TetherLayer: React.FC<TetherLayerProps> = ({ tethers, c }) => {
  if (tethers.length === 0) return null;
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
        // Behind every card (cards use zOrder 1..N as their z-index): connector lines tuck UNDER the cards like a node graph, visible only in the gaps between them. At zIndex 10 the line drew OVER any card with zOrder < 10, so it cut through the chat and the browsers.
        zIndex: 0,
      }}
    >
      <defs>
        <marker
          id="tether-arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          orient="auto"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill={c.accent.primary} opacity={0.8} />
        </marker>
      </defs>
      {tethers.map((t) => (
        <g
          key={t.key}
          style={{
            opacity: t.fading ? 0 : 1,
            transition: `opacity ${TETHER_FADE_MS}ms ease-out`,
          }}
        >
          {/* Soft halo from a plain wide translucent stroke, no SVG blur filter:
              the filter re-rasterized every frame and the marching-ants + pulse
              that justified it are gone, so a static double-stroke is the cheap,
              calm version of the same glow. */}
          <path
            d={t.path}
            fill="none"
            stroke={c.accent.primary}
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.12}
          />
          <path
            d={t.path}
            fill="none"
            stroke={c.accent.primary}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.75}
            markerEnd="url(#tether-arrow)"
          />
          {t.label && (
            // Same glass capsule language as the narrator pills; the old white accent-bordered box read as a stray form element.
            <g transform={`translate(${t.labelX},${t.labelY})`}>
              <rect
                x={-6}
                y={-15}
                width={t.label.length * 7.5 + 12}
                height={22}
                rx={11}
                fill="rgba(24,14,32,0.85)"
                opacity={0.98}
              />
              <text
                x={t.label.length * 7.5 / 2}
                y={1}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fontFamily="inherit"
                fill="rgba(255,255,255,0.92)"
              >
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
