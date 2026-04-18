import React from 'react';
import Box from '@mui/material/Box';

interface CardGlowOverlayProps {
  accentColor: string;
  accentHover: string;
  glowFading: boolean;
  glowFadeMs: number;
}

const CardGlowOverlay: React.FC<CardGlowOverlayProps> = ({
  accentColor,
  accentHover,
  glowFading,
  glowFadeMs,
}) => (
  <Box
    className="agent-card-glow-overlays"
    sx={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      borderRadius: 'inherit',
      zIndex: 20,
      opacity: glowFading ? 0 : 1,
      transition: `opacity ${glowFadeMs}ms ease-out`,
    }}
  >
    {/* Rotating conic gradient border */}
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        overflow: 'hidden',
        padding: '3px',
        mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
        WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
        maskComposite: 'exclude',
        WebkitMaskComposite: 'xor',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: '-50%',
          background: `conic-gradient(from 0deg, transparent 0%, ${accentColor} 25%, transparent 50%, ${accentColor} 75%, transparent 100%)`,
          animation: 'agent-card-rotate-glow 3s linear infinite',
        },
        '@keyframes agent-card-rotate-glow': {
          '100%': { transform: 'rotate(360deg)' },
        },
      }}
    />
    {/* Top edge shimmer */}
    <Box
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '2px',
        background: `linear-gradient(90deg, transparent, ${accentColor}, ${accentHover}, ${accentColor}, transparent)`,
        backgroundSize: '200% 100%',
        animation: 'agent-card-border-shimmer 2s linear infinite',
        '@keyframes agent-card-border-shimmer': {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      }}
    />
    {/* Inner shadow overlay */}
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        boxShadow: `inset 0 0 40px ${accentColor}30, inset 0 0 80px ${accentColor}12`,
        animation: 'agent-card-inner-pulse 2s ease-in-out infinite',
        '@keyframes agent-card-inner-pulse': {
          '0%, 100%': {
            boxShadow: `inset 0 0 40px ${accentColor}30, inset 0 0 80px ${accentColor}12`,
          },
          '50%': {
            boxShadow: `inset 0 0 50px ${accentColor}40, inset 0 0 100px ${accentColor}18`,
          },
        },
      }}
    />
  </Box>
);

export default React.memo(CardGlowOverlay);
