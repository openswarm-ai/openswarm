import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ONBOARDING_TOOL_INTEGRATIONS, ToolIntegration } from './onboardingConstants';

interface ToolsStepProps {
  connecting: string | null;
  connectedTools: Set<string>;
  onToolConnect: (integration: ToolIntegration) => void;
  onDismiss: () => void;
}

const ToolsStep: React.FC<ToolsStepProps> = ({
  connecting, connectedTools, onToolConnect, onDismiss,
}) => {
  const c = useClaudeTokens();

  return (
    <>
      <Typography sx={{ fontSize: '1.3rem', fontWeight: 700, color: c.text.primary, mb: 0.5, textAlign: 'center' }}>
        Connect Your Accounts
      </Typography>
      <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mb: 0.5, textAlign: 'center' }}>
        10+ tools already active with no setup needed
      </Typography>
      <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, mb: 3, textAlign: 'center' }}>
        Connect services below for even more capabilities
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 2.5 }}>
        {ONBOARDING_TOOL_INTEGRATIONS.map((ig) => {
          const isConnected = connectedTools.has(ig.name);
          const isConnecting = connecting === ig.name;
          return (
            <Box
              key={ig.name}
              onClick={() => !isConnected && !isConnecting && !connecting && onToolConnect(ig)}
              sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                p: 1.5, borderRadius: `${c.radius.md}px`,
                border: `1px solid ${isConnected ? `${ig.color}40` : c.border.subtle}`,
                cursor: isConnected ? 'default' : connecting ? 'wait' : 'pointer',
                bgcolor: isConnected ? `${ig.color}08` : 'transparent',
                transition: 'border-color 0.15s, background 0.15s',
                ...(!isConnected && !connecting && { '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}05` } }),
              }}
            >
              <Box>
                <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.primary }}>{ig.name}</Typography>
                <Typography sx={{ fontSize: '0.65rem', color: c.text.muted }}>{ig.desc}</Typography>
              </Box>
              {isConnected ? (
                <CheckCircleIcon sx={{ fontSize: 18, color: ig.color }} />
              ) : (
                <Typography sx={{ fontSize: '0.68rem', color: isConnecting ? ig.color : c.text.tertiary }}>
                  {isConnecting ? 'Connecting...' : 'Connect \u2192'}
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>

      <Button
        onClick={onDismiss}
        fullWidth
        variant={connectedTools.size > 0 ? 'contained' : 'text'}
        sx={{
          textTransform: 'none', fontSize: '0.78rem', borderRadius: `${c.radius.md}px`,
          ...(connectedTools.size > 0
            ? { bgcolor: c.accent.primary, color: '#fff', '&:hover': { bgcolor: c.accent.hover } }
            : { color: c.text.ghost, '&:hover': { bgcolor: 'transparent', color: c.text.muted } }),
        }}
      >
        {connectedTools.size > 0 ? 'Done' : 'Skip for now'}
      </Button>
    </>
  );
};

export default ToolsStep;
