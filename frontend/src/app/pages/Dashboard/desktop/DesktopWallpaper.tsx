import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { useThemeMode } from '@/shared/styles/ThemeContext';

/**
 * Monterey-style layered-ridge wallpaper. Design rules: scenery not signal (long smooth ridges,
 * luminance ramps pale sky -> deep indigo so glass chrome always has contrast), depth via aerial
 * perspective (far ridges blurred + desaturated, near ridges sharp with a lit crest), and life via
 * ONE imperceptible compositor-only drift (120s, transform-only, off under reduced-motion).
 */
function DesktopWallpaper(): React.ReactElement {
  const { mode } = useThemeMode();
  // The user's real OS wallpaper when the Electron bridge can supply it (never bundled); SVG scenery otherwise.
  const [realWallpaper, setRealWallpaper] = useState<string | null>(null);
  useEffect(() => {
    const getWallpaper = (window as unknown as { openswarm?: { getDesktopWallpaper?: () => Promise<string | null> } })
      .openswarm?.getDesktopWallpaper;
    if (!getWallpaper) return;
    let cancelled = false;
    getWallpaper().then((dataUrl) => { if (!cancelled && dataUrl) setRealWallpaper(dataUrl); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (realWallpaper) {
    return (
      <Box aria-hidden sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <Box component="img" src={realWallpaper} alt="" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        {mode === 'dark' && <Box sx={{ position: 'absolute', inset: 0, background: 'rgba(12,6,24,0.38)' }} />}
      </Box>
    );
  }

  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        '& .osw-wp-drift': {
          animation: 'osw-wp-drift 120s ease-in-out infinite alternate',
          willChange: 'transform',
        },
        '& .osw-wp-drift-far': {
          animation: 'osw-wp-drift-far 160s ease-in-out infinite alternate',
          willChange: 'transform',
        },
        '@keyframes osw-wp-drift': {
          from: { transform: 'translateX(0px)' },
          to: { transform: 'translateX(-28px)' },
        },
        '@keyframes osw-wp-drift-far': {
          from: { transform: 'translateX(0px)' },
          to: { transform: 'translateX(18px)' },
        },
        '@media (prefers-reduced-motion: reduce)': {
          '& .osw-wp-drift, & .osw-wp-drift-far': { animation: 'none' },
        },
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', inset: '-2%', width: '104%', height: '104%', display: 'block' }}
      >
        <defs>
          <linearGradient id="osw-wp-sky" x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0" stopColor="#dcd9e8" />
            <stop offset="0.45" stopColor="#c8b2d4" />
            <stop offset="1" stopColor="#b490c4" />
          </linearGradient>
          <linearGradient id="osw-wp-redridge" x1="0.15" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor="#e0517c" />
            <stop offset="0.5" stopColor="#c33f92" />
            <stop offset="1" stopColor="#a5349b" />
          </linearGradient>
          <linearGradient id="osw-wp-pink" x1="0.3" y1="0" x2="0.7" y2="1">
            <stop offset="0" stopColor="#e7b3cd" />
            <stop offset="0.55" stopColor="#cb8fb8" />
            <stop offset="1" stopColor="#bd5f92" />
          </linearGradient>
          <linearGradient id="osw-wp-magenta" x1="0.2" y1="0" x2="0.7" y2="1">
            <stop offset="0" stopColor="#c14fb4" />
            <stop offset="1" stopColor="#96319b" />
          </linearGradient>
          <linearGradient id="osw-wp-purple" x1="0.1" y1="0.1" x2="0.7" y2="1">
            <stop offset="0" stopColor="#8f35c9" />
            <stop offset="0.6" stopColor="#7326b8" />
            <stop offset="1" stopColor="#5c1da6" />
          </linearGradient>
          <linearGradient id="osw-wp-violet" x1="0" y1="0" x2="0.9" y2="0.9">
            <stop offset="0" stopColor="#8d33dd" />
            <stop offset="1" stopColor="#6716d5" />
          </linearGradient>
          <linearGradient id="osw-wp-indigo" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0" stopColor="#5b21c9" />
            <stop offset="0.6" stopColor="#3b1a9e" />
            <stop offset="1" stopColor="#271581" />
          </linearGradient>
          <linearGradient id="osw-wp-crest" x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <filter id="osw-wp-far" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id="osw-wp-mid" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        <rect x="-40" y="-20" width="1680" height="1040" fill="url(#osw-wp-sky)" />

        {/* Far layer: soft pink billow owning the right half + red-magenta ridge from the top-left. Blurred + gentle = aerial distance. */}
        <g className="osw-wp-drift-far">
          <path
            d="M700,40 C900,180 1010,330 1230,360 C1400,382 1520,300 1620,190 L1620,1020 L700,1020 Z"
            fill="url(#osw-wp-pink)"
            filter="url(#osw-wp-far)"
            opacity="0.9"
          />
          <path
            d="M-20,-20 L520,-20 C470,140 500,300 640,440 C480,610 220,600 -20,680 Z"
            fill="url(#osw-wp-redridge)"
            filter="url(#osw-wp-mid)"
            opacity="0.95"
          />
        </g>

        {/* Mid layer: the magenta band bridging the composition. */}
        <g className="osw-wp-drift">
          <path
            d="M-20,600 C280,470 560,540 840,640 C1090,728 1360,700 1620,580 L1620,1020 L-20,1020 Z"
            fill="url(#osw-wp-magenta)"
            filter="url(#osw-wp-mid)"
            opacity="0.9"
          />
          <path
            d="M-20,596 C280,466 560,536 840,636"
            fill="none"
            stroke="url(#osw-wp-crest)"
            strokeWidth="5"
            opacity="0.35"
          />

          {/* Deep purple shoulder anchoring the bottom-left. */}
          <path
            d="M-20,560 C220,520 420,600 580,760 C420,900 180,880 -20,910 Z"
            fill="url(#osw-wp-purple)"
          />
          <path
            d="M-20,558 C220,518 420,598 578,756"
            fill="none"
            stroke="url(#osw-wp-crest)"
            strokeWidth="4"
            opacity="0.3"
          />
        </g>

        {/* Near layer: violet crest + indigo foreground wave, sharpest, with lit crests. */}
        <g>
          <path
            d="M-20,820 C320,690 700,830 1010,772 C1260,726 1450,790 1620,720 L1620,1020 L-20,1020 Z"
            fill="url(#osw-wp-violet)"
            opacity="0.95"
          />
          <path
            d="M-20,816 C320,686 700,826 1010,768 C1260,722 1450,786 1620,716"
            fill="none"
            stroke="url(#osw-wp-crest)"
            strokeWidth="4"
            opacity="0.4"
          />
          <path
            d="M-20,882 C300,780 680,912 1000,856 C1260,810 1470,890 1620,834 L1620,1020 L-20,1020 Z"
            fill="url(#osw-wp-indigo)"
          />
          <path
            d="M-20,878 C300,776 680,908 1000,852 C1260,806 1470,886 1620,830"
            fill="none"
            stroke="url(#osw-wp-crest)"
            strokeWidth="3"
            opacity="0.35"
          />
        </g>
      </svg>
      {mode === 'dark' && (
        <Box sx={{ position: 'absolute', inset: 0, background: 'rgba(12,6,24,0.38)' }} />
      )}
    </Box>
  );
}

export default DesktopWallpaper;
