import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

// The floating "scroll to bottom" affordance. Presentational: visibility + click come from the scroll
// cluster in AgentChat (step 6 owns when it shows / what it scrolls); this is only the button.
export function ScrollToBottomButton({
  visible, onScrollToBottom, c,
}: { visible: boolean; onScrollToBottom: () => void; c: ReturnType<typeof useClaudeTokens> }) {
  if (!visible) return null;
  return (
    <Tooltip title="Scroll to bottom">
      <IconButton
        onClick={onScrollToBottom}
        sx={{
          position: 'absolute',
          bottom: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          color: c.accent.primary,
          width: 36,
          height: 36,
          '&:hover': { bgcolor: c.bg.secondary },
          boxShadow: c.shadow.md,
          zIndex: 1,
        }}
      >
        <KeyboardArrowDownIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
