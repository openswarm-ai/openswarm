import React from 'react';
import Tooltip, { tooltipClasses } from '@mui/material/Tooltip';
import { styled } from '@mui/material/styles';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

export const WarmTooltip = styled(
    ({ className, ...props }: React.ComponentProps<typeof Tooltip> & { className?: string }) => (
      <Tooltip {...props} classes={{ popper: className }} />
    )
  )<{ tokens: ClaudeTokens }>(({ tokens: c }) => ({
    [`& .${tooltipClasses.tooltip}`]: {
      backgroundColor: c.bg.inverse,
      color: c.text.inverse,
      fontFamily: c.font.sans,
      fontSize: '0.78rem',
      fontWeight: 500,
      padding: '6px 12px',
      borderRadius: c.radius.md,
      boxShadow: c.shadow.md,
      letterSpacing: '0.01em',
    },
    [`& .${tooltipClasses.arrow}`]: {
      color: c.bg.inverse,
    },
}));