import React from 'react';
import Box from '@mui/material/Box';

export const PIXEL_SALMON = ['#C46B57', '#D4795F', '#E8927A', '#F0A088', '#F5B49E'];
export const PIXEL_BLUE = ['#445588', '#5577AA', '#6688BB', '#7799CC', '#88AADD'];

export const PixelBarOuter: React.FC<{ value: number; max: number; width?: number; palette?: string[]; tokens: any }> = ({ value, max, width = 16, palette = PIXEL_SALMON, tokens: c }) => {
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
  return (
    <Box sx={{ display: 'flex', gap: '1px', mt: 0.25 }}>
      {Array.from({ length: width }, (_, i) => (
        <Box
          key={i}
          sx={{
            width: 5,
            height: 5,
            bgcolor: i < filled
              ? palette[Math.min(palette.length - 1, Math.floor((i / Math.max(filled - 1, 1)) * (palette.length - 1)))]
              : c.border.subtle,
            opacity: i < filled ? 1 : 0.3,
          }}
        />
      ))}
    </Box>
  );
};
