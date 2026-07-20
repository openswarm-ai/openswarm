import React from 'react';
import Box from '@mui/material/Box';
import { useThemeMode } from '@/shared/styles/ThemeContext';

/**
 * Monterey-style layered wave wallpaper for the desktop-shell canvas. Pure SVG so it ships with
 * the bundle, scales to any viewport, and stays crisp; sits under the wash/grain/dot-grid layers.
 */
function DesktopWallpaper(): React.ReactElement {
  const { mode } = useThemeMode();
  return (
    <Box
      aria-hidden
      sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', inset: 0, display: 'block' }}
      >
        <defs>
          <linearGradient id="osw-wp-sky" x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0" stopColor="#d6d3e4" />
            <stop offset="0.55" stopColor="#c39bc6" />
            <stop offset="1" stopColor="#b06ab8" />
          </linearGradient>
          <linearGradient id="osw-wp-pinkridge" x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor="#e4a9c6" />
            <stop offset="0.5" stopColor="#cb9bbf" />
            <stop offset="1" stopColor="#bd5f92" />
          </linearGradient>
          <linearGradient id="osw-wp-redridge" x1="0.2" y1="0" x2="0.7" y2="1">
            <stop offset="0" stopColor="#e2547e" />
            <stop offset="0.55" stopColor="#c33f92" />
            <stop offset="1" stopColor="#a5349b" />
          </linearGradient>
          <linearGradient id="osw-wp-purple" x1="0.1" y1="0.2" x2="0.8" y2="1">
            <stop offset="0" stopColor="#9a3bbc" />
            <stop offset="0.6" stopColor="#7726b8" />
            <stop offset="1" stopColor="#641dab" />
          </linearGradient>
          <linearGradient id="osw-wp-indigo" x1="0.15" y1="0" x2="0.75" y2="1">
            <stop offset="0" stopColor="#6716d5" />
            <stop offset="0.65" stopColor="#3b1a9e" />
            <stop offset="1" stopColor="#271581" />
          </linearGradient>
          <linearGradient id="osw-wp-violetcrest" x1="0" y1="0" x2="1" y2="0.8">
            <stop offset="0" stopColor="#8f35e0" />
            <stop offset="1" stopColor="#6716d5" />
          </linearGradient>
          <filter id="osw-wp-soft" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>

        <rect width="1600" height="1000" fill="url(#osw-wp-sky)" />

        {/* Far pink ridge sweeping the right half */}
        <path
          d="M820,0 C980,260 1120,380 1320,330 C1450,296 1540,220 1600,150 L1600,1000 L820,1000 Z"
          fill="url(#osw-wp-pinkridge)"
          filter="url(#osw-wp-soft)"
          opacity="0.9"
        />

        {/* Red-magenta ridge descending from the top-left */}
        <path
          d="M0,0 L560,0 C480,150 520,300 660,470 C540,650 300,640 0,720 Z"
          fill="url(#osw-wp-redridge)"
        />

        {/* Mid magenta band bridging center */}
        <path
          d="M0,560 C340,430 620,520 900,660 C1120,770 1380,720 1600,600 L1600,1000 L0,1000 Z"
          fill="#ab37ad"
          opacity="0.85"
          filter="url(#osw-wp-soft)"
        />

        {/* Deep purple shoulder, left */}
        <path
          d="M0,520 C260,470 470,560 640,740 C460,900 200,850 0,880 Z"
          fill="url(#osw-wp-purple)"
        />

        {/* Violet crest above the foreground wave */}
        <path
          d="M0,830 C360,680 760,850 1060,780 C1280,730 1460,800 1600,740 L1600,1000 L0,1000 Z"
          fill="url(#osw-wp-violetcrest)"
          opacity="0.92"
        />

        {/* Foreground indigo wave */}
        <path
          d="M0,880 C320,760 720,910 1020,850 C1260,802 1470,880 1600,830 L1600,1000 L0,1000 Z"
          fill="url(#osw-wp-indigo)"
        />
      </svg>
      {mode === 'dark' && (
        <Box sx={{ position: 'absolute', inset: 0, background: 'rgba(12,6,24,0.38)' }} />
      )}
    </Box>
  );
}

export default DesktopWallpaper;
