import Box from '@mui/material/Box';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

// The glowing "Continue chat" bar that replaces the composer while this chat card is glow-highlighted
// (e.g. a browser card handed the user here). Clicking dismisses the glow. Lifted verbatim from
// AgentChat.
export function ContinueChatGlow({ onDismissGlow, c }: { onDismissGlow?: () => void; c: ReturnType<typeof useClaudeTokens> }) {
  return (
    <Box
      onClick={(e) => { e.stopPropagation(); onDismissGlow?.(); }}
      sx={{
        mx: 1.5,
        mb: 1.5,
        py: 1.25,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 2.5,
        cursor: 'pointer',
        fontWeight: 600,
        fontSize: '0.875rem',
        color: c.accent.primary,
        border: `1.5px solid ${c.accent.primary}`,
        background: `${c.accent.primary}08`,
        boxShadow: `0 0 12px ${c.accent.primary}25, inset 0 0 12px ${c.accent.primary}08`,
        transition: 'background 0.15s, box-shadow 0.15s',
        '&:hover': {
          background: `${c.accent.primary}14`,
          boxShadow: `0 0 24px ${c.accent.primary}50, inset 0 0 20px ${c.accent.primary}18`,
        },
      }}
    >
      Continue chat
    </Box>
  );
}
