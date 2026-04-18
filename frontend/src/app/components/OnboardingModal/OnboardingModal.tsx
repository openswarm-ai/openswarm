import React from 'react';
import { Box, Modal } from '@mui/material';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useOnboarding } from './components/useOnboarding';
import ProviderStep from './components/ProviderStep';
import ToolsStep from './components/ToolsStep';

const OnboardingModal: React.FC = () => {
  const c = useClaudeTokens();
  const {
    open, step, connecting, nineRouterReady, connectedTools,
    dismiss, handleConnect, handleToolConnect, handleApiKey, handleSkip,
  } = useOnboarding();

  if (!open) return null;

  return (
    <Modal open={open} onClose={handleSkip} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Box sx={{
        width: 480, maxWidth: '90vw', bgcolor: c.bg.surface, borderRadius: `${c.radius.xl}px`,
        border: `1px solid ${c.border.subtle}`, p: 3.5, outline: 'none',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        {step === 'tools' ? (
          <ToolsStep
            connecting={connecting}
            connectedTools={connectedTools}
            onToolConnect={handleToolConnect}
            onDismiss={dismiss}
          />
        ) : (
          <ProviderStep
            connecting={connecting}
            nineRouterReady={nineRouterReady}
            onConnect={handleConnect}
            onApiKey={handleApiKey}
            onSkip={handleSkip}
          />
        )}
      </Box>
    </Modal>
  );
};

export default OnboardingModal;
