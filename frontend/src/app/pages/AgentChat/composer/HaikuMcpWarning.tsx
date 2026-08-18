import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useAppSelector } from '@/shared/hooks';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Proactive Haiku-overflow warning. Each connected MCP adds a sizeable tools-schema chunk to every
// Claude request; Haiku 4.5's window is 5x smaller than Sonnet/Opus, so 5+ simultaneously-enabled MCPs
// reliably push a one-line message past the limit. We surface this BEFORE the user sends so they don't
// waste a turn on "Prompt is too long". Lifted verbatim from AgentChat; self-gating (renders null
// unless Haiku + 5 or more enabled MCPs).
export function HaikuMcpWarning({ model, c }: { model: string; c: ReturnType<typeof useClaudeTokens> }) {
  // Each connected MCP adds a meaningful chunk of tool-schema tokens to every request; Haiku 4.5's 200K window can't hold 5+ of them.
  const toolItems = useAppSelector((state) => state.tools.items);
  const isHaiku = (model || '').toLowerCase().startsWith('haiku');
  const enabledMcpCount = Object.values(toolItems).filter(
    (t) => t.enabled && t.mcp_config && Object.keys(t.mcp_config).length > 0,
  ).length;
  if (!isHaiku || enabledMcpCount < 5) return null;
  return (
    <Box
      sx={{
        mx: 2,
        mb: 1,
        p: 1.5,
        borderRadius: `${c.radius.lg}px`,
        border: `1px solid ${c.status.warning}40`,
        bgcolor: `${c.status.warning}10`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.2,
      }}
    >
      <Box sx={{ flexShrink: 0, mt: 0.2 }}>
        <ErrorSlime size={20} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary, mb: 0.4 }}>
          Haiku may run out of room with {enabledMcpCount} apps connected
        </Typography>
        <Typography sx={{ fontSize: '0.75rem', color: c.text.secondary, lineHeight: 1.45 }}>
          Haiku is the fastest Claude model but holds the least at once.
          Each connected app adds instructions Claude has to read first.
          If your message fails with “Prompt is too long,” turn off a few
          apps (Microsoft 365 is the heaviest) or switch to Sonnet/Opus,
          both have 5× more room.
        </Typography>
      </Box>
    </Box>
  );
}
