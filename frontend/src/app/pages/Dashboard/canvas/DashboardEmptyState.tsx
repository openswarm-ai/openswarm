import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useDashboardActive } from '@/shared/hooks/useDashboardActive';
import { useAppSelector } from '@/shared/hooks';
import {
  hasModelConnected,
  hasFreeTrialActive,
} from '@/app/components/Onboarding/steps/skipPredicates';
import ChatBubbleTeardrop from '../ChatBubbleTeardrop';

// Broad, one-click-complete prompts so a brand-new user gets the "it works"
// moment without thinking up a task. Each runs to a useful result on its own.
const STARTER_PROMPTS = [
  'Find the latest AI news and give me a short summary',
  'Research the top 3 standing desks and compare them',
  'Explain how RAG works like I\'m five',
  'Write a short poem about the sea',
];

const DashboardEmptyState: React.FC<{
  c: ClaudeTokens;
  onLaunch?: (prompt: string, mode: string, model: string) => void;
}> = ({ c, onLaunch }) => {
  // The host hides Dashboard with visibility:hidden (not display:none), which keeps
  // CSS animations ticking; gate on active so the shimmer only burns while watched.
  const active = useDashboardActive();
  const model = useAppSelector((s) => s.settings.data.default_model);
  const mode = useAppSelector((s) => s.settings.data.default_mode);
  const canRun = useAppSelector((s) => hasFreeTrialActive(s) || hasModelConnected(s));
  const [launching, setLaunching] = React.useState(false);

  // Only offer chips once a run can actually succeed (free trial armed or a real
  // model connected); otherwise fall back to the plain hint.
  const showChips = !!onLaunch && canRun;

  const launch = (prompt: string) => {
    if (launching || !onLaunch) return;
    setLaunching(true); // empty state unmounts on first session, but guard a fast double-click
    onLaunch(prompt, mode, model);
  };

  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <style>{`@keyframes empty-state-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
        No agents running
      </Typography>
      <Typography
        sx={{
          fontSize: '0.9rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.7,
          background: `linear-gradient(90deg, ${c.text.ghost} 0%, ${c.text.ghost} 40%, ${c.text.primary} 50%, ${c.text.ghost} 60%, ${c.text.ghost} 100%)`,
          backgroundSize: '200% 100%',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          color: 'transparent',
          animation: active ? 'empty-state-shimmer 6s linear infinite' : 'none',
        }}
      >
        Click the
        {/* Literal toolbar glyph; the shimmer's transparent color would hide it, so reset color here. */}
        <Box component="span" sx={{ display: 'inline-flex', color: c.text.tertiary }}>
          <ChatBubbleTeardrop sx={{ fontSize: 15 }} />
        </Box>
        below to launch your first agent
      </Typography>

      {showChips && (
        <Box
          sx={{
            mt: 3,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 1,
            maxWidth: 520,
            pointerEvents: 'auto',
          }}
        >
          <Typography sx={{ width: '100%', textAlign: 'center', color: c.text.ghost, fontSize: '0.8rem', mb: 0.5 }}>
            or try one of these
          </Typography>
          {STARTER_PROMPTS.map((prompt) => (
            <Box
              component="button"
              key={prompt}
              onClick={() => launch(prompt)}
              disabled={launching}
              sx={{
                px: 1.4,
                py: 0.8,
                borderRadius: 2,
                border: `1px solid ${c.border.medium}`,
                background: c.bg.surface,
                color: c.text.secondary,
                fontSize: '0.82rem',
                cursor: launching ? 'default' : 'pointer',
                opacity: launching ? 0.5 : 1,
                fontFamily: 'inherit',
                transition: 'background 150ms ease-in-out, border-color 150ms ease-in-out',
                '&:hover': launching ? {} : { background: c.bg.elevated, borderColor: c.border.strong },
              }}
            >
              {prompt}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default DashboardEmptyState;
