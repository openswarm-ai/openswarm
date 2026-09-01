import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SubscriptionProvider } from './subscriptionProviders';

interface Props {
  provider: SubscriptionProvider;
  connected: boolean;
  connecting: boolean;
  confirmingDisconnect: boolean;
  disconnecting: boolean;
  error?: string;
  userCode?: string;
  onConnect: () => void;
  onRequestDisconnect: () => void;
  onCancelDisconnect: () => void;
  onDisconnect: () => void;
}

const SubscriptionCard: React.FC<Props> = ({
  provider, connected, connecting, confirmingDisconnect, disconnecting, error, userCode,
  onConnect, onRequestDisconnect, onCancelDisconnect, onDisconnect,
}) => {
  const c = useClaudeTokens();
  const dotColor = connected ? c.status.success : connecting ? c.accent.primary : c.border.medium;
  const linkButton = {
    border: 'none', background: 'transparent', p: 0, cursor: 'pointer',
    fontFamily: 'inherit', fontSize: '0.6875rem', transition: 'color 0.15s ease',
  } as const;

  return (
    <Box sx={{
      p: 1.5, borderRadius: `${c.radius.md}px`,
      border: `1px solid ${connected ? c.status.success + '30' : connecting ? c.accent.primary + '30' : c.border.subtle}`,
      bgcolor: connected ? `${c.status.success}06` : connecting ? `${c.accent.primary}06` : 'transparent',
      opacity: provider.preview ? 0.5 : 1,
      transition: c.transition,
      '&:hover': provider.preview ? {} : {
        borderColor: connected ? c.status.success + '4d' : c.border.medium,
      },
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Box sx={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: dotColor,
            transition: 'background-color 0.3s ease',
            ...(connecting ? {
              animation: 'sub-pulse 1.4s ease-in-out infinite',
              '@keyframes sub-pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
            } : {}),
          }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.primary }}>{provider.name}</Typography>
            <Typography noWrap sx={{ fontSize: '0.625rem', color: connecting ? c.accent.primary : c.text.muted, transition: 'color 0.2s ease' }}>
              {connecting ? 'Waiting for authorization...' : provider.desc}
            </Typography>
          </Box>
        </Box>

        {provider.preview ? (
          <Typography sx={{ fontSize: '0.625rem', color: c.text.ghost, fontStyle: 'italic', flexShrink: 0 }}>
            Coming soon
          </Typography>
        ) : connected ? (
          disconnecting ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, flexShrink: 0 }}>
              <CircularProgress size={14} sx={{ color: c.text.ghost }} />
              <Typography sx={{ fontSize: '0.6875rem', color: c.text.muted }}>Disconnecting...</Typography>
            </Box>
          ) : confirmingDisconnect ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.6875rem', color: c.text.secondary }}>Disconnect?</Typography>
              <Box component="button" type="button" onClick={onCancelDisconnect} sx={{ ...linkButton, color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
                Cancel
              </Box>
              <Box component="button" type="button" onClick={onDisconnect} sx={{ ...linkButton, color: c.status.error, fontWeight: 600, '&:hover': { opacity: 0.75 } }}>
                Disconnect
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.6875rem', fontWeight: 500, color: c.status.success }}>Connected</Typography>
              <Box component="button" type="button" onClick={onRequestDisconnect} sx={{ ...linkButton, color: c.text.tertiary, '&:hover': { color: c.status.error } }}>
                Disconnect
              </Box>
            </Box>
          )
        ) : connecting && userCode ? (
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Typography sx={{ fontSize: '0.6875rem', color: c.text.muted }}>Enter code:</Typography>
            <Typography sx={{ fontSize: '0.875rem', fontWeight: 700, color: c.accent.primary, fontFamily: c.font.mono, letterSpacing: '0.1em' }}>{userCode}</Typography>
          </Box>
        ) : connecting ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, flexShrink: 0 }}>
            <CircularProgress size={14} sx={{ color: c.accent.primary }} />
            <Typography sx={{ fontSize: '0.6875rem', color: c.accent.primary }}>Connecting...</Typography>
          </Box>
        ) : (
          <Button onClick={onConnect} variant="outlined" size="small" sx={{ textTransform: 'none', fontSize: '0.6875rem', fontWeight: 600, color: c.text.primary, borderColor: c.border.medium, borderRadius: `${c.radius.sm}px`, minWidth: 72, flexShrink: 0, '&:hover': { borderColor: c.accent.primary, bgcolor: `${c.accent.primary}0a` }, transition: 'all 0.2s ease' }}>
            Connect
          </Button>
        )}
      </Box>

      {error && (
        <Typography sx={{ mt: 0.75, fontSize: '0.625rem', color: c.status.error, lineHeight: 1.4 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
};

export default SubscriptionCard;
