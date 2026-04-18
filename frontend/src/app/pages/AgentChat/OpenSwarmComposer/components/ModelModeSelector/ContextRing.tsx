import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ContextRing: React.FC<{
  used: number; limit: number; accentColor: string; trackColor: string;
}> = ({ used, limit, accentColor, trackColor }) => {
  if (used === 0) return null;
  const pct = Math.min((used / limit) * 100, 100);
  const size = 20;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  const tooltip = `${pct.toFixed(1)}% \u00B7 ${formatTokenCount(used)} / ${formatTokenCount(limit)} context used`;

  return (
    <Tooltip title={tooltip}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', p: 0.5 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={accentColor} strokeWidth={strokeWidth}
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </Box>
    </Tooltip>
  );
};

export default ContextRing;
