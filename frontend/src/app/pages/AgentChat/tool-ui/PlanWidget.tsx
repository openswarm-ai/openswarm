import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import CircularProgress from '@mui/material/CircularProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { PlanProps } from './showUiPayload';

const MAX_VISIBLE = 6;

/** Tool-UI-style plan card: progress summary bar + step checklist. */
function PlanWidget({ props }: { props: PlanProps }): React.ReactElement {
  const c = useClaudeTokens();
  const done = props.steps.filter((s) => s.status === 'completed').length;
  const visible = props.steps.slice(0, MAX_VISIBLE);
  const hidden = props.steps.length - visible.length;

  return (
    <Box
      sx={{
        width: 320,
        borderRadius: '14px',
        border: `1px solid ${c.border.subtle}`,
        bgcolor: c.bg.elevated,
        p: 2,
      }}
    >
      {props.title && (
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary, mb: 1.5 }}>
          {props.title}
        </Typography>
      )}
      <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary, mb: 0.5 }}>
        {done} of {props.steps.length} complete
      </Typography>
      <Box sx={{ height: 4, borderRadius: 2, bgcolor: c.border.subtle, mb: 1.5, overflow: 'hidden' }}>
        <Box sx={{ height: '100%', width: `${(done / props.steps.length) * 100}%`, bgcolor: c.text.primary, transition: 'width 0.3s ease' }} />
      </Box>
      {visible.map((step, i) => (
        <Box key={`${i}-${step.label.slice(0, 24)}`} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.6 }}>
          {step.status === 'completed' ? (
            <CheckCircleIcon sx={{ fontSize: 17, color: c.text.primary }} />
          ) : step.status === 'in_progress' ? (
            <CircularProgress size={14} thickness={5} sx={{ color: c.text.secondary }} />
          ) : (
            <RadioButtonUncheckedIcon sx={{ fontSize: 17, color: c.border.strong }} />
          )}
          <Typography
            sx={{
              fontSize: '0.8125rem',
              fontWeight: step.status === 'in_progress' ? 600 : 500,
              color: step.status === 'pending' ? c.text.muted : c.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {step.label}
          </Typography>
        </Box>
      ))}
      {hidden > 0 && (
        <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, pt: 0.5 }}>
          ... {hidden} more
        </Typography>
      )}
    </Box>
  );
}

export default PlanWidget;
