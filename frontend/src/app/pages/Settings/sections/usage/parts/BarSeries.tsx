import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface BarDatum {
  label: string;
  value: number;
  suffix?: string;
}

interface BarSeriesProps {
  data: BarDatum[];
  max?: number;
}

/** Ranked horizontal bars that grow in on mount; width rides a CSS transition, so no JS runs per frame. */
const BarSeries: React.FC<BarSeriesProps> = ({ data, max }) => {
  const c = useClaudeTokens();
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const peak = max ?? Math.max(1, ...data.map((d) => d.value));

  return (
    <Box>
      {data.map((d, i) => (
        <Box key={d.label} sx={{ py: 0.7 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.35 }}>
            <Typography sx={{ color: c.text.primary, fontSize: '0.8125rem', fontWeight: 500 }}>{d.label}</Typography>
            <Typography sx={{ color: c.text.secondary, fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' }}>
              {d.value.toLocaleString()}{d.suffix ? ` ${d.suffix}` : ''}
            </Typography>
          </Box>
          <Box sx={{ height: 5, borderRadius: 3, background: c.border.subtle, overflow: 'hidden' }}>
            <Box
              sx={{
                height: '100%',
                borderRadius: 3,
                background: c.accent.primary,
                opacity: 0.55 + 0.45 * (1 - i / Math.max(1, data.length)),
                width: grown ? `${Math.max(2, (d.value / peak) * 100)}%` : '0%',
                transition: `width 620ms cubic-bezier(0.22,1,0.36,1) ${i * 45}ms`,
              }}
            />
          </Box>
        </Box>
      ))}
    </Box>
  );
};

export default BarSeries;
