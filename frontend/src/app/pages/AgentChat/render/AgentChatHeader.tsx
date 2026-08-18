import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import CloseIcon from '@mui/icons-material/Close';
import { Typewriter } from '@/app/components/feedback/Animated';
import { friendlyStatusLabel } from '@/shared/statusLabel';
import { displayChatTitle, isLegacyAutoName } from '@/shared/state/sessionDisplay';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface AgentChatHeaderProps {
  session: AgentSession;
  isDraft: boolean;
  id: string | undefined;
  connectionMode: string | undefined;
  c: ReturnType<typeof useClaudeTokens>;
  resolveModelLabel: (value: string | null | undefined) => string;
  onClose?: () => void;
  onResetHistory: () => void;
}

// Chat header band: title (+ live status) over model/branch/cost/tool meta, with reset-history + close.
// Presentational — the reset handler is passed in so this stays free of session-mutation logic.
export function AgentChatHeader({
  session, isDraft, id, connectionMode, c, resolveModelLabel, onClose, onResetHistory,
}: AgentChatHeaderProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.5,
        // No seam: the header is just a band of typography inside the chat panel; transparent bg + air carry it, no hairline. (An earlier bg.surface here read lighter than the body and pulled focus.)
        bgcolor: 'transparent',
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typewriter
            value={displayChatTitle(session)}
            enabled={!!session.name && !isLegacyAutoName(session.name)}
          >
            {(t) => <Typography noWrap sx={{ color: c.text.primary, fontWeight: 600 }}>{t}</Typography>}
          </Typewriter>
          {/* statusStyle was a vacuous guard here (its lookup always fell back to a truthy default and
              the colors were never read), so the prop was dropped in the follow-up split. */}
          {!isDraft && session.status !== 'completed' && session.status !== 'stopped' && (
            // Status speaks only when it needs the user; finished work sits quiet.
            <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: c.text.tertiary, whiteSpace: 'nowrap' }}>
                {friendlyStatusLabel(session.status)}
              </Typography>
            </Box>
          )}
        </Box>
        {(!isDraft || session.is_welcome_draft) && (
          // Welcome draft shows just the model so the header isn't bare; real runs add branch + cost.
          <Box sx={{ display: 'flex', gap: 1.5, mt: 0.25, alignItems: 'center' }}>
            <Typography variant="caption" sx={{ color: c.text.tertiary }}>
              {resolveModelLabel(session.model)}
            </Typography>
            {!isDraft && session.branch_name && (
              <Typography variant="caption" sx={{ color: c.text.tertiary }}>
                {session.branch_name}
              </Typography>
            )}
            {(() => {
              if (!(session.cost_usd > 0)) return null;
              // The SDK reports a per-call $ figure regardless of how the request was routed. For requests that went through a subscription path, that figure is misleading, the user pays flat-rate. Show "subscription" instead in those cases. Show $ only when the call was actually metered (Anthropic API key, OpenAI API key, etc.). Model-id signals (these are short_name values from the BUILTIN_MODELS registry): - `*-api` → pinned Anthropic API key (METERED) - `*-cc` → pinned Claude Pro/Max via 9Router (sub) - plain sonnet/opus/haiku + openswarm-pro mode → Pro proxy (sub) - plain sonnet/opus/haiku + own_key mode → API key (METERED) - gpt-5.4* / gpt-5.3* → ChatGPT Plus/Pro via 9Router (sub) - gemini-*  → Gemini Advanced via 9Router (sub)
              const m = (session.model || '').toLowerCase();
              const isApiRoute = m.endsWith('-api');
              if (isApiRoute) {
                return (
                  <Typography variant="caption" sx={{ color: c.accent.primary }}>
                    ${session.cost_usd.toFixed(4)}
                  </Typography>
                );
              }
              const isCcRoute = m.endsWith('-cc');
              const isPlainAnthropic = m === 'sonnet' || m === 'opus' || m === 'haiku';
              const isProRoute = isPlainAnthropic && connectionMode === 'openswarm-pro';
              const isOwnKeyAnthropic = isPlainAnthropic && connectionMode !== 'openswarm-pro';
              const isOpenAISub = m.startsWith('gpt-5') || m.startsWith('gpt-4') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
              const isGeminiSub = m.startsWith('gemini-');
              const isSubscriptionRouted = isCcRoute || isProRoute || isOpenAISub || isGeminiSub;
              if (isSubscriptionRouted) {
                return (
                  <Typography
                    variant="caption"
                    sx={{ color: c.text.tertiary }}
                    title="Routed through subscription, flat-rate, per-call cost not metered"
                  >
                    subscription
                  </Typography>
                );
              }
              // own-key Anthropic OR anything else → real $ figure.
              void isOwnKeyAnthropic;
              return (
                <Typography variant="caption" sx={{ color: c.accent.primary }}>
                  ${session.cost_usd.toFixed(4)}
                </Typography>
              );
            })()}
            {(() => {
              const mcpCount = session.active_mcps?.length ?? 0;
              if (mcpCount === 0) return null;
              return (
                <Typography
                  variant="caption"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontVariantNumeric: 'tabular-nums' }}
                  title={`${mcpCount} tool${mcpCount === 1 ? '' : 's'} connected.`}
                >
                  <Box component="span" sx={{ color: c.text.tertiary }}>
                    {mcpCount} tool{mcpCount === 1 ? '' : 's'}
                  </Box>
                </Typography>
              );
            })()}
          </Box>
        )}
      </Box>
      {!isDraft && id && (
        <Tooltip title="Reset history">
          <IconButton
            size="small"
            onClick={onResetHistory}
            sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
          >
            <RestartAltIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {onClose && (
        <IconButton onClick={onClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
