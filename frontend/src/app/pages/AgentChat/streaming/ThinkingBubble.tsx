import React from 'react';
import Box from '@mui/material/Box';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { THINKING_LABELS } from '../thinkingLabels';

const thinkingShimmerKeyframes = `
@keyframes thinking-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
`;

export const ThinkingBubble: React.FC<{ label?: string | null }> = ({ label }) => {
  const c = useClaudeTokens();
  const shimmerBase = c.text.tertiary;
  const shimmerHighlight = c.text.primary;
  // Aux-LLM label wins; otherwise the pill stays plain "Thinking". The whimsical verbs read as personality
  // in the per-message thinking bubble (MessageBubble), but as a vague, confusing status on a working card.
  const display = label ? `${label}…` : `${THINKING_LABELS[0].live}…`;
  // A quiet shimmer LINE, not a bordered card: status shares one visual language with the
  // per-message thinking row, so only real content gets bubbles (the ChatGPT/Claude pattern).
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start', my: 0.75 }}>
      <style>{thinkingShimmerKeyframes}</style>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, py: 0.5, px: 1, ml: -1 }}>
        <Box
          component="span"
          sx={{
            fontSize: '0.8125rem',
            fontWeight: 500,
            background: `linear-gradient(90deg, ${shimmerBase} 0%, ${shimmerBase} 40%, ${shimmerHighlight} 50%, ${shimmerBase} 60%, ${shimmerBase} 100%)`,
            backgroundSize: '200% 100%',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            color: 'transparent',
            animation: 'thinking-shimmer 2s linear infinite',
            transition: 'opacity 0.25s',
          }}
        >
          {display}
        </Box>
      </Box>
    </Box>
  );
};
