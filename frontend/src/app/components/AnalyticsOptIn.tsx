import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettings } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const AnalyticsOptIn: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings.data);
  const loaded = useAppSelector((s) => s.settings.loaded);

  if (!loaded || settings.analytics_opt_in !== null) return null;

  const handleChoice = (optIn: boolean) => {
    dispatch(updateSettings({ ...settings, analytics_opt_in: optIn }));
  };

  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1400,
        maxWidth: 480,
        width: '90%',
      }}
    >
      <Paper
        elevation={0}
        sx={{
          p: 2.5,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: 3,
          boxShadow: c.shadow.lg,
        }}
      >
        <Typography sx={{ color: c.text.primary, fontSize: '0.9rem', fontWeight: 600, mb: 0.5 }}>
          Help improve OpenSwarm
        </Typography>
        <Typography sx={{ color: c.text.muted, fontSize: '0.8rem', lineHeight: 1.5, mb: 2 }}>
          Share anonymous usage statistics like session counts, feature usage, and model preferences.
          No conversations, file paths, or personal information — ever.
          You can change this anytime in Settings.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button
            onClick={() => handleChoice(false)}
            sx={{
              color: c.text.muted,
              textTransform: 'none',
              fontSize: '0.82rem',
              '&:hover': { bgcolor: `${c.text.tertiary}0A` },
            }}
          >
            No thanks
          </Button>
          <Button
            variant="contained"
            onClick={() => handleChoice(true)}
            sx={{
              bgcolor: c.accent.primary,
              '&:hover': { bgcolor: c.accent.pressed },
              textTransform: 'none',
              fontSize: '0.82rem',
              borderRadius: 1.5,
              px: 2,
            }}
          >
            Share anonymous data
          </Button>
        </Box>
      </Paper>
    </Box>
  );
};

export default AnalyticsOptIn;
