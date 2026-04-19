import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { getActionLabel } from '@/shared/browsers/browserCommandHandler/browserCommandTypes';

interface BrowserActionOverlayProps {
  agentAction: string | null;
  lastAction: string | null;
  actionSeq: number;
  coords?: { xPercent: number; yPercent: number };
  accentColor: string;
  accentRgb: string;
  showGlow: boolean;
  agentActive: boolean;
  browserId: string;
  showFrostedOverlay: boolean;
}

const BrowserActionOverlay: React.FC<BrowserActionOverlayProps> = ({
  agentAction, lastAction, actionSeq, coords, accentColor, accentRgb,
  showGlow, agentActive, browserId, showFrostedOverlay,
}) => (
  <>
    {(agentAction === 'screenshot' || lastAction === 'screenshot') && (
      <Box key={`flash-${actionSeq}`} sx={{
        position: 'absolute', inset: 0, bgcolor: '#fff', pointerEvents: 'none', zIndex: 15,
        animation: 'camera-flash 0.4s ease-out forwards',
        '@keyframes camera-flash': { '0%': { opacity: 0.45 }, '100%': { opacity: 0 } },
      }} />
    )}

    {agentAction === 'get_text' && (
      <Box sx={{
        position: 'absolute', left: 0, right: 0, height: '3px', zIndex: 15, pointerEvents: 'none',
        background: `linear-gradient(180deg, transparent, ${accentColor}90, transparent)`,
        boxShadow: `0 0 12px ${accentColor}60`,
        animation: 'scan-sweep 1.5s ease-in-out infinite alternate',
        '@keyframes scan-sweep': { '0%': { top: '0%' }, '100%': { top: 'calc(100% - 3px)' } },
      }} />
    )}

    {(agentAction === 'click' || lastAction === 'click') && (
      <Box key={`ripple-${actionSeq}`} sx={{
        position: 'absolute',
        top: `${(coords?.yPercent ?? 0.5) * 100}%`,
        left: `${(coords?.xPercent ?? 0.5) * 100}%`,
        width: 40, height: 40, borderRadius: '50%', border: `2px solid ${accentColor}`,
        transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 15,
        animation: 'click-ripple 0.5s ease-out forwards',
        '@keyframes click-ripple': {
          '0%': { opacity: 0.8, width: 10, height: 10, borderWidth: '2px' },
          '100%': { opacity: 0, width: 60, height: 60, borderWidth: '1px' },
        },
      }} />
    )}

    {agentAction === 'type' && (
      <Box sx={{
        position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: '4px', alignItems: 'center', px: 1, py: 0.5, borderRadius: '8px',
        bgcolor: `${accentColor}20`, border: `1px solid ${accentColor}40`, zIndex: 15, pointerEvents: 'none',
      }}>
        {[0, 1, 2].map((i) => (
          <Box key={i} sx={{
            width: 5, height: 5, borderRadius: '50%', bgcolor: accentColor,
            animation: `typing-dot 1s ease-in-out ${i * 0.15}s infinite`,
            '@keyframes typing-dot': {
              '0%, 60%, 100%': { opacity: 0.3, transform: 'scale(0.8)' },
              '30%': { opacity: 1, transform: 'scale(1.2)' },
            },
          }} />
        ))}
      </Box>
    )}

    {showGlow && !agentActive && (
      <Box sx={{
        position: 'absolute', inset: 0, zIndex: 14, pointerEvents: 'none', borderRadius: 'inherit',
        boxShadow: `inset 0 0 40px rgba(${accentRgb},0.35), inset 0 0 80px rgba(${accentRgb},0.15)`,
        animation: `accent-glow-${browserId} 2s ease-in-out infinite`,
        [`@keyframes accent-glow-${browserId}`]: {
          '0%, 100%': { boxShadow: `inset 0 0 40px rgba(${accentRgb},0.35), inset 0 0 80px rgba(${accentRgb},0.15)` },
          '50%': { boxShadow: `inset 0 0 50px rgba(${accentRgb},0.45), inset 0 0 100px rgba(${accentRgb},0.22)` },
        },
      }} />
    )}

    {showFrostedOverlay && (
      <Box sx={{
        position: 'absolute', inset: 0, zIndex: 16, backdropFilter: 'blur(2px)', bgcolor: 'rgba(0,0,0,0.15)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5,
        animation: 'overlay-fade-in 0.25s ease-out',
        '@keyframes overlay-fade-in': { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
      }}>
        <CircularProgress size={28} thickness={3} sx={{ color: accentColor }} />
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, borderRadius: '10px',
          bgcolor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)', border: `1px solid ${accentColor}30`,
        }}>
          <SmartToyOutlinedIcon sx={{ fontSize: 14, color: accentColor }} />
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: '#fff', letterSpacing: '0.02em' }}>
            {getActionLabel(agentAction ?? '')}
          </Typography>
        </Box>
      </Box>
    )}
  </>
);

export default BrowserActionOverlay;
