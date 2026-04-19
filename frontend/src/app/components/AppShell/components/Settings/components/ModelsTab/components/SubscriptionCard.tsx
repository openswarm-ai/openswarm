import React from 'react';
import { Box, Typography, Button, CircularProgress } from '@mui/material';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export const SUBSCRIPTION_PROVIDERS = [
  { id: 'claude', name: 'Claude Pro / Max', desc: 'Sonnet, Opus, Haiku — use your Anthropic subscription', color: '#E8927A', preview: false },
  { id: 'gemini-cli', name: 'Gemini Advanced', desc: 'Gemini 2.5 Pro and Flash — use your Google subscription', color: '#4285F4', preview: true },
  { id: 'codex', name: 'ChatGPT Plus / Pro', desc: 'GPT-5.4, o3, o4-mini — use your OpenAI subscription', color: '#74AA9C', preview: true },
  { id: 'github', name: 'GitHub Copilot', desc: 'Claude + GPT models via your Copilot subscription', color: '#8B949E', preview: true },
];

type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[0];

interface SubscriptionCardProps {
  provider: SubscriptionProvider;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  userCode?: string;
  disconnecting?: boolean;
}

const SubscriptionCard: React.FC<SubscriptionCardProps> = ({ provider, connected, onConnect, onDisconnect, connecting, userCode, disconnecting }) => {
  const c = useClaudeTokens();
  const isPreview = (provider as any).preview;
  return (
    <Box sx={{
      p: 1.5, borderRadius: `${c.radius.md}px`,
      border: `1px solid ${connected ? c.status.success + '30' : connecting ? c.accent.primary + '30' : c.border.subtle}`,
      bgcolor: connected ? `${c.status.success}04` : connecting ? `${c.accent.primary}04` : 'transparent',
      opacity: isPreview ? 0.5 : 1,
      transition: 'all 0.3s ease',
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            bgcolor: connected ? c.status.success : connecting ? c.accent.primary : c.border.medium,
            transition: 'background-color 0.3s ease',
            ...(connecting ? {
              animation: 'pulse-dot 1.5s ease-in-out infinite',
              '@keyframes pulse-dot': {
                '0%, 100%': { opacity: 1, transform: 'scale(1)' },
                '50%': { opacity: 0.4, transform: 'scale(0.8)' },
              },
            } : {}),
          }} />
          <Box>
            <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: c.text.primary }}>{provider.name}</Typography>
            <Typography sx={{ fontSize: '0.65rem', color: connecting ? c.accent.primary : c.text.muted, transition: 'color 0.3s ease' }}>
              {connecting ? 'Waiting for authorization...' : provider.desc}
            </Typography>
          </Box>
        </Box>
        {isPreview ? (
          <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, fontStyle: 'italic' }}>
            Coming soon
          </Typography>
        ) : connected ? (
          disconnecting ? (
            <CircularProgress size={14} sx={{ color: c.text.ghost }} />
          ) : (
            <Typography onClick={onDisconnect} sx={{ fontSize: '0.68rem', color: c.text.tertiary, cursor: 'pointer', '&:hover': { color: c.status.error }, transition: 'color 0.2s ease' }}>
              Disconnect
            </Typography>
          )
        ) : connecting && userCode ? (
          <Box sx={{ textAlign: 'right' }}>
            <Typography sx={{ fontSize: '0.68rem', color: c.text.muted }}>Enter code:</Typography>
            <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: c.accent.primary, fontFamily: 'monospace', letterSpacing: '0.1em' }}>{userCode}</Typography>
          </Box>
        ) : connecting ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
            <CircularProgress size={14} sx={{ color: c.accent.primary }} />
            <Typography sx={{ fontSize: '0.68rem', color: c.accent.primary }}>Connecting...</Typography>
          </Box>
        ) : (
          <Button onClick={onConnect} variant="outlined" size="small" sx={{ textTransform: 'none', fontSize: '0.7rem', color: c.text.primary, borderColor: c.border.medium, minWidth: 70, '&:hover': { borderColor: c.accent.primary }, transition: 'all 0.2s ease' }}>
            Connect
          </Button>
        )}
      </Box>
    </Box>
  );
};

export default SubscriptionCard;
