// Bottom-left nudge shown at launch when a subscription login died while the app was closed (silent token rotation): names the provider(s) and jumps straight to Settings -> Models to reconnect. Stays put until the user acts; the X dismisses it.

import React from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { hideProviderHealthToast } from '@/shared/state/subscriptionsSlice';
import { openSettingsModal } from '@/shared/state/settingsSlice';

export default function ProviderHealthToast() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.subscriptions.healthToastOpen);
  const dead = useAppSelector((s) => s.subscriptions.healthDead);

  const onReconnect = React.useCallback(() => {
    dispatch(openSettingsModal('models'));
    dispatch(hideProviderHealthToast());
  }, [dispatch]);

  const labels = dead.map((d) => d.label).join(' and ');

  return (
    <Snackbar
      open={open && dead.length > 0}
      autoHideDuration={null}
      // Clickaway would kill the pill on the user's first canvas click, before they read it; only the X or Reconnect dismisses.
      onClose={(event, reason) => { if (reason !== 'clickaway') dispatch(hideProviderHealthToast()); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="warning"
        sx={{
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          '& .MuiAlert-action': { alignItems: 'center', pt: 0 },
        }}
        action={
          <>
            <Button size="small" onClick={onReconnect} sx={{ color: c.accent.primary, fontWeight: 700 }}>
              Reconnect
            </Button>
            <IconButton
              size="small"
              aria-label="Dismiss"
              onClick={() => dispatch(hideProviderHealthToast())}
              sx={{ color: c.text.muted, ml: 0.25, '&:hover': { color: c.text.primary } }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      >
        Your {labels} login{dead.length > 1 ? 's have' : ' has'} expired; chats on {dead.length > 1 ? 'them' : 'it'} will fail until you reconnect.
      </Alert>
    </Snackbar>
  );
}
