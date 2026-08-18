import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useAppDispatch } from '@/shared/hooks';
import { openSettingsCard } from '@/shared/state/dashboardLayoutSlice';
import { clearContextOverflow, type AgentSession } from '@/shared/state/agentsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

// The in-transcript "Context full" / "Out of tokens" / "Sign-in required" card, shown at the top of the
// scroll surface when the backend flags session.context_overflow. Lifted verbatim from AgentChat's
// render; returns null when there is no overflow so the caller can pass it unconditionally as the
// MessageListBody header slot.
export function ContextOverflowCard({
  session,
  id,
  workflowEditId,
  c,
}: {
  session: AgentSession;
  id: string | undefined;
  workflowEditId?: string;
  c: ReturnType<typeof useClaudeTokens>;
}) {
  const dispatch = useAppDispatch();
  if (!session.context_overflow) return null;
  const reason = session.context_overflow.reason;
  const isAuth = reason === 'openswarm_pro_auth_expired' || reason === 'anthropic_auth_invalid' || reason === 'auth_error';
  const isOutOfTokens = reason === 'out_of_tokens';
  const title = isOutOfTokens ? 'Out of tokens' : isAuth ? 'Sign-in required' : 'Context full';
  const primaryLabel = isOutOfTokens ? 'Got it' : isAuth ? 'Open Settings' : 'Start a fresh chat';
  // In the workflow build chat, switching models here also sets the workflow's scheduled run model, so spell that consequence out.
  const message = isOutOfTokens && workflowEditId
    ? `${session.context_overflow.message} Whichever model you switch to here becomes the model this workflow runs on.`
    : session.context_overflow.message;
  const onPrimary = () => {
    if (isOutOfTokens) {
      if (id) dispatch(clearContextOverflow({ sessionId: id }));
    } else if (isAuth) {
      dispatch(openSettingsCard({ tab: 'models' }));
    } else {
      const did = session.dashboard_id;
      window.location.hash = did ? `#/dashboard/${did}` : '#/';
    }
  };
  return (
    <Box sx={{
      mt: 1,
      mb: 1.5,
      p: 1.5,
      borderRadius: 1.5,
      border: `1px solid ${c.border.strong}`,
      bgcolor: c.bg.secondary,
    }}>
      <Typography variant="body2" sx={{ color: c.text.primary, fontWeight: 500, mb: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block', mb: 1.25 }}>
        {message}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Typography
          component="button"
          variant="caption"
          onClick={onPrimary}
          sx={{
            cursor: 'pointer',
            border: `1px solid ${c.border.medium}`,
            borderRadius: 1,
            px: 1.25,
            py: 0.5,
            bgcolor: 'transparent',
            color: c.text.primary,
            '&:hover': { bgcolor: c.bg.elevated },
          }}
        >
          {primaryLabel}
        </Typography>
      </Box>
    </Box>
  );
}
