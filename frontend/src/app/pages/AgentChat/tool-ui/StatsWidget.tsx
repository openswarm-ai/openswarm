import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { StatsProps } from './showUiPayload';

/** Tool-UI-style stat tiles: label, value, optional signed delta. */
function StatsWidget({ props }: { props: StatsProps }): React.ReactElement {
  const c = useClaudeTokens();
  return (
    <Box sx={{ maxWidth: 460 }}>
      {props.title && (
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary, mb: 1 }}>
          {props.title}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {props.stats.map((s, i) => (
          <Box
            key={`${i}-${s.label.slice(0, 16)}`}
            sx={{
              minWidth: 120,
              flex: '1 1 120px',
              borderRadius: '12px',
              border: `1px solid ${c.border.subtle}`,
              bgcolor: c.bg.elevated,
              px: 1.5,
              py: 1.25,
            }}
          >
            <Typography sx={{ fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: c.text.tertiary }}>
              {s.label}
            </Typography>
            <Typography sx={{ fontSize: '1.125rem', fontWeight: 700, color: c.text.primary, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>
              {s.value}
            </Typography>
            {s.delta && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, mt: 0.25 }}>
                {s.direction === 'down' ? (
                  <ArrowDownwardIcon sx={{ fontSize: 12, color: c.status.error }} />
                ) : (
                  <ArrowUpwardIcon sx={{ fontSize: 12, color: c.status.success }} />
                )}
                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: s.direction === 'down' ? c.status.error : c.status.success }}>
                  {s.delta}
                </Typography>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export default StatsWidget;
