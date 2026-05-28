import React from 'react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { Tether } from '../geometry/dashboardTethers';

const TETHER_FADE_MS = 2500;

interface TetherLayerProps {
  tethers: Tether[];
  c: ClaudeTokens;
}

const TetherLayer: React.FC<TetherLayerProps> = ({ tethers, c }) => {
  if (tethers.length === 0) return null;
  return (
    <svg
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      <defs>
        <filter id="tether-glow-f" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
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
      <style>{`
        @keyframes tether-flow { to { stroke-dashoffset: -16; } }
        @keyframes tether-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      `}</style>
      {tethers.map((t) => (
        <g
          key={t.key}
          style={{
            opacity: t.fading ? 0 : 1,
            transition: `opacity ${TETHER_FADE_MS}ms ease-out`,
          }}
        >
          <path
            d={t.path}
            fill="none"
            stroke={c.accent.primary}
            strokeWidth={8}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.2}
            filter="url(#tether-glow-f)"
          />
          <path
            d={t.path}
            fill="none"
            stroke={c.accent.primary}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.65}
            markerEnd="url(#tether-arrow)"
            style={{ animation: 'tether-pulse 2s ease-in-out infinite' }}
          />
          <path
            d={t.path}
            fill="none"
            stroke={c.accent.primary}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="8 8"
            opacity={0.9}
            style={{ animation: 'tether-flow 0.6s linear infinite' }}
          />
          {t.label && (
            <g transform={`translate(${t.labelX},${t.labelY})`}>
              <rect
                x={-4}
                y={-14}
                width={t.label.length * 7.5 + 8}
                height={20}
                rx={4}
                fill={c.bg.surface}
                stroke={c.accent.primary}
                strokeWidth={1}
                opacity={0.95}
              />
              <text
                x={t.label.length * 7.5 / 2}
                y={1}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fontFamily="inherit"
                fill={c.accent.primary}
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
