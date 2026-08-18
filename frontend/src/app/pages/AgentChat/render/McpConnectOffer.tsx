import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { McpSuggestion } from '../model/useMcpActivation';

// In-transcript "Connect <tool> so the agent can do this" offer for preflight MCP suggestions.
// Presentational — activation state + handler come from useMcpActivation via props. Suggest-only:
// activation is the user's click through the gated MCPActivate endpoint.
export function McpConnectOffer({
  suggestions, activatingId, error, onActivate, onDismiss, c,
}: {
  suggestions: McpSuggestion[];
  activatingId: string | null;
  error: string | null;
  onActivate: (s: McpSuggestion) => void;
  onDismiss: () => void;
  c: ReturnType<typeof useClaudeTokens>;
}) {
  return (
    <Box sx={{ mt: 1, mb: 1, px: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5, overflowAnchor: 'none' }}>
      {suggestions.map((s) => (
        <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" sx={{ color: c.text.secondary, flex: 1, minWidth: 0 }}>
            Connect{' '}
            <Box component="span" sx={{ color: c.text.primary, fontWeight: 500 }}>{s.title}</Box>
            {' '}so the agent can do this
          </Typography>
          <Typography
            component="button"
            variant="caption"
            disabled={activatingId === s.id}
            onClick={() => onActivate(s)}
            sx={{
              border: 'none',
              background: 'none',
              p: 0,
              color: c.accent.primary,
              cursor: activatingId === s.id ? 'wait' : 'pointer',
              opacity: activatingId === s.id ? 0.5 : 1,
              '&:hover': { textDecoration: activatingId ? 'none' : 'underline' },
              flexShrink: 0,
            }}
          >
            {activatingId === s.id ? 'Connecting…' : 'Connect'}
          </Typography>
        </Box>
      ))}
      {error && (
        <Typography variant="caption" sx={{ display: 'block', color: c.status.error }}>
          {error}
        </Typography>
      )}
      <Box
        role="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        sx={{ alignSelf: 'flex-start', color: c.text.muted, cursor: 'pointer', fontSize: '0.75rem', '&:hover': { color: c.text.secondary } }}
      >
        Dismiss
      </Box>
    </Box>
  );
}
