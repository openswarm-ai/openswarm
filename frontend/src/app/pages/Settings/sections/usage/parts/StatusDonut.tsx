import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

interface StatusDonutProps {
  slices: DonutSlice[];
  size?: number;
}

const P_R = 42;
const P_CIRC = 2 * Math.PI * P_R;

/** Donut whose arcs sweep in via stroke-dashoffset; SVG stroke transitions run on the compositor. */
const StatusDonut: React.FC<StatusDonutProps> = ({ slices, size = 116 }) => {
  const c = useClaudeTokens();
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const total = Math.max(1, slices.reduce((a, s) => a + s.value, 0));

  let offset = 0;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5 }}>
      <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="50" cy="50" r={P_R} fill="none" stroke={c.border.subtle} strokeWidth="11" />
          {slices.map((s, i) => {
            const frac = s.value / total;
            const dash = drawn ? frac * P_CIRC : 0;
            const rot = offset;
            offset += frac;
            return (
              <circle
                key={s.label}
                cx="50" cy="50" r={P_R} fill="none"
                stroke={s.color} strokeWidth="11" strokeLinecap="butt"
                strokeDasharray={`${dash} ${P_CIRC}`}
                style={{
                  transform: `rotate(${rot * 360}deg)`,
                  transformOrigin: '50% 50%',
                  transition: `stroke-dasharray 700ms cubic-bezier(0.22,1,0.36,1) ${i * 110}ms`,
                }}
              />
            );
          })}
        </svg>
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <Typography sx={{ color: c.text.primary, fontSize: '1.05rem', fontWeight: 600, lineHeight: 1 }}>
            {Math.round((slices[0]?.value ?? 0) / total * 100)}%
          </Typography>
          <Typography sx={{ color: c.text.ghost, fontSize: '0.625rem', mt: 0.25 }}>clean</Typography>
        </Box>
      </Box>
      <Box>
        {slices.map((s) => (
          <Box key={s.label} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.35 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '2px', background: s.color, flexShrink: 0 }} />
            <Typography sx={{ color: c.text.secondary, fontSize: '0.78125rem' }}>{s.label}</Typography>
            <Typography sx={{ color: c.text.primary, fontSize: '0.78125rem', fontVariantNumeric: 'tabular-nums', ml: 0.5 }}>
              {s.value.toLocaleString()}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default StatusDonut;
