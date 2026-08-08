import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface ColumnDatum {
  key: string;
  value: number;
  caption?: string;
}

interface ActivityColumnsProps {
  data: ColumnDatum[];
  height?: number;
  highlightIndex?: number;
}

/** Column chart with a staggered grow-in; heights ride CSS transitions so nothing animates per frame. */
const ActivityColumns: React.FC<ActivityColumnsProps> = ({ data, height = 84, highlightIndex }) => {
  const c = useClaudeTokens();
  const [grown, setGrown] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const peak = Math.max(1, ...data.map((d) => d.value));

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height }}>
        {data.map((d, i) => (
          <Box
            key={d.key}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', cursor: 'default' }}
          >
            <Box
              sx={{
                borderRadius: '3px 3px 0 0',
                background: i === highlightIndex || i === hover ? c.accent.primary : c.text.ghost,
                opacity: i === highlightIndex || i === hover ? 1 : 0.42,
                height: grown ? `${Math.max(2, (d.value / peak) * 100)}%` : '0%',
                transition: `height 600ms cubic-bezier(0.22,1,0.36,1) ${Math.min(i * 18, 420)}ms, background 140ms ease, opacity 140ms ease`,
              }}
            />
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.6, minHeight: 16 }}>
        <Typography sx={{ color: c.text.ghost, fontSize: '0.6875rem' }}>{data[0]?.caption ?? ''}</Typography>
        <Typography sx={{ color: hover === null ? c.text.ghost : c.text.secondary, fontSize: '0.6875rem', fontVariantNumeric: 'tabular-nums' }}>
          {hover === null ? (data[data.length - 1]?.caption ?? '') : `${data[hover].caption}: ${data[hover].value.toLocaleString()}`}
        </Typography>
      </Box>
    </Box>
  );
};

export default ActivityColumns;
