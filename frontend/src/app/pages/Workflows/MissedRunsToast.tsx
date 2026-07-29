// Bottom-left nudge shown on launch when scheduled runs elapsed while the app was closed. It stays put until the user acts (no auto-hide): Review opens the Workflows app (its Home surfaces the missed runs); the X dismisses it.

import React from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { hideMissedRunsToast } from '@/shared/state/missedRunsSlice';
import { openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import { useNudgeTurn } from '@/app/components/overlays/nudgeQueue';

export default function MissedRunsToast() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.missedRuns.toastOpen);
  const count = useAppSelector((s) => s.missedRuns.items.length);
  const myTurn = useNudgeTurn('missedRuns');

  const onReview = React.useCallback(() => {
    dispatch(openWorkflowsApp());
    dispatch(hideMissedRunsToast());
  }, [dispatch]);

  return (
    <Snackbar
      open={open && count > 0 && myTurn}
      autoHideDuration={null}
      onClose={() => dispatch(hideMissedRunsToast())}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="info"
        sx={{
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          '& .MuiAlert-action': { alignItems: 'center', pt: 0 },
        }}
        action={
          <>
            <Button size="small" onClick={onReview} sx={{ color: c.accent.primary, fontWeight: 700 }}>
              Review
            </Button>
            <IconButton
              size="small"
              aria-label="Dismiss"
              onClick={() => dispatch(hideMissedRunsToast())}
              sx={{ color: c.text.muted, ml: 0.25, '&:hover': { color: c.text.primary } }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </>
        }
      >
        {`${count} scheduled run${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} missed while you were away`}
      </Alert>
    </Snackbar>
  );
}
