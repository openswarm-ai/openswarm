import { useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Fade from '@mui/material/Fade';
import { useAppDispatch } from '@/shared/hooks';
import { clearMcpSuggestions, type AgentSession } from '@/shared/state/agentsSlice';
import { dismissMcpSuggestion } from '@/shared/state/settingsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { useMcpActivation } from '../model/useMcpActivation';

// The docked "Looks like this might need an integration" banner above the composer. Lifted verbatim
// from AgentChat. Shares the caller's useMcpActivation instance so activation state stays consistent
// with the in-transcript McpConnectOffer.
export function McpSuggestionsBanner({
  session,
  id,
  c,
  mcpActivation,
}: {
  session: AgentSession;
  id: string | undefined;
  c: ReturnType<typeof useClaudeTokens>;
  mcpActivation: ReturnType<typeof useMcpActivation>;
}) {
  const dispatch = useAppDispatch();
  // Holds the last non-empty suggestions so the docked banner's exit fade renders them instead of going blank the instant the array is cleared.
  const mcpSnapshotRef = useRef<Array<{ id: string; title: string; description: string; reason?: string }>>([]);
  const list = session.mcp_suggestions ?? [];
  if (list.length) mcpSnapshotRef.current = list;
  const display = mcpSnapshotRef.current;
  return (
    <Fade in={list.length > 0} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box sx={{
        mx: 2,
        mb: 1,
        p: 1.5,
        borderRadius: 1.5,
        border: `1px solid ${c.border.medium}`,
        bgcolor: c.bg.secondary,
        position: 'relative',
      }}>
        <Box
          role="button"
          aria-label="Dismiss integration suggestion"
          onClick={() => {
            if (!id) return;
            dispatch(clearMcpSuggestions({ sessionId: id }));
            dispatch(dismissMcpSuggestion(display.map((s) => s.id)));
          }}
          sx={{
            position: 'absolute',
            top: 6,
            right: 8,
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            lineHeight: 1,
            color: c.text.muted,
            cursor: 'pointer',
            borderRadius: 0.75,
            '&:hover': { color: c.text.primary, bgcolor: c.bg.elevated },
          }}
        >
          ×
        </Box>
        <Typography variant="body2" sx={{ color: c.text.primary, fontWeight: 500, mb: 0.5, pr: 3 }}>
          Looks like this might need an integration
        </Typography>
        <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block', mb: 1 }}>
          Activating one of these will let the agent answer in a single round-trip.
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {display.map((s) => (
            <Box key={s.id} sx={{ flexBasis: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" sx={{ color: c.text.primary, fontWeight: 500 }}>
                  {s.title}
                </Typography>
                {s.reason && (
                  <Typography variant="caption" sx={{ display: 'block', color: c.text.tertiary }}>
                    {s.reason}
                  </Typography>
                )}
              </Box>
              <Typography
                component="button"
                variant="caption"
                disabled={mcpActivation.activatingId === s.id}
                onClick={() => mcpActivation.activate(s, session.id)}
                sx={{
                  cursor: mcpActivation.activatingId === s.id ? 'wait' : 'pointer',
                  border: `1px solid ${c.border.medium}`,
                  borderRadius: 1,
                  px: 1.25,
                  py: 0.5,
                  bgcolor: 'transparent',
                  color: c.text.primary,
                  opacity: mcpActivation.activatingId === s.id ? 0.5 : 1,
                  '&:hover': { bgcolor: mcpActivation.activatingId ? 'transparent' : c.bg.elevated },
                  flexShrink: 0,
                }}
              >
                {mcpActivation.activatingId === s.id ? 'Activating…' : 'Activate'}
              </Typography>
            </Box>
          ))}
        </Box>
        {mcpActivation.error && (
          <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: c.status.error }}>
            {mcpActivation.error}
          </Typography>
        )}
      </Box>
    </Fade>
  );
}
