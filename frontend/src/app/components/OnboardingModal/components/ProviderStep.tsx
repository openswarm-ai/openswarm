import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { SUBSCRIPTION_PROVIDERS } from './onboardingConstants';

interface ProviderStepProps {
  connecting: string | null;
  nineRouterReady: boolean | null;
  onConnect: (providerId: string) => void;
  onApiKey: () => void;
  onSkip: () => void;
}

const ProviderStep: React.FC<ProviderStepProps> = ({
  connecting, nineRouterReady, onConnect, onApiKey, onSkip,
}) => {
  const c = useClaudeTokens();

  return (
    <>
      <Typography sx={{ fontSize: '1.3rem', fontWeight: 700, color: c.text.primary, mb: 0.5, textAlign: 'center' }}>
        Welcome to OpenSwarm
      </Typography>
      <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 3, textAlign: 'center' }}>
        Connect an AI model to get started
      </Typography>

      <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
        Use your existing subscription
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 2.5 }}>
        {SUBSCRIPTION_PROVIDERS.map((p) => (
          <Box
            key={p.id}
            onClick={() => !p.preview && !connecting && nineRouterReady && onConnect(p.id)}
            sx={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
              cursor: p.preview || !nineRouterReady ? 'default' : connecting ? 'wait' : 'pointer',
              opacity: p.preview ? 0.5 : !nineRouterReady ? 0.6 : 1,
              transition: 'border-color 0.15s, background 0.15s',
              ...(!p.preview && nineRouterReady && { '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` } }),
            }}
          >
            <Box>
              <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.primary }}>{p.name}</Typography>
              <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>{p.desc}</Typography>
            </Box>
            <Typography sx={{ fontSize: '0.68rem', color: p.preview ? c.text.ghost : connecting === p.id ? c.accent.primary : !nineRouterReady ? c.text.ghost : c.text.tertiary, fontStyle: p.preview ? 'italic' : 'normal' }}>
              {p.preview ? 'Coming soon' : connecting === p.id ? 'Connecting...' : !nineRouterReady && nineRouterReady !== false ? 'Starting...' : 'Connect \u2192'}
            </Typography>
          </Box>
        ))}
      </Box>

      <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
        Or use an API key
      </Typography>
      <Box
        onClick={onApiKey}
        sx={{
          p: 1.5, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
          cursor: 'pointer', mb: 2.5,
          '&:hover': { borderColor: c.border.medium, bgcolor: `${c.accent.primary}05` },
        }}
      >
        <Typography sx={{ fontSize: '0.78rem', color: c.text.primary }}>
          I have an API key
        </Typography>
        <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>
          Go to Settings &rarr; Models to enter your key
        </Typography>
      </Box>

      <Button
        onClick={onSkip}
        fullWidth
        sx={{ textTransform: 'none', fontSize: '0.72rem', color: c.text.ghost, '&:hover': { bgcolor: 'transparent', color: c.text.muted } }}
      >
        Skip for now
      </Button>
    </>
  );
};

export default ProviderStep;
