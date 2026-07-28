// Bottom-left nudge when an event watcher keeps failing (site changed, sign-in
// needed, feed dead): names the workflow and jumps to its Event triggers panel,
// where the activity feed says exactly why. A silently dead watcher is the
// trust-killer this exists to prevent.

import React from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { hideTriggersHealthToast } from '@/shared/state/triggersHealthSlice';
import { openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';

export default function TriggerHealthToast() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.triggersHealth.toastOpen);
  const items = useAppSelector((s) => s.triggersHealth.items);
  const first = items[0];

  const onReview = React.useCallback(() => {
    if (first) dispatch(openWorkflowsApp({ workflowId: first.workflow_id }));
    dispatch(hideTriggersHealthToast());
  }, [dispatch, first]);

  const extra = items.length > 1 ? ` (and ${items.length - 1} more watcher${items.length > 2 ? 's' : ''})` : '';

  return (
    <Snackbar
      open={open && !!first}
      autoHideDuration={null}
      onClose={(event, reason) => { if (reason !== 'clickaway') dispatch(hideTriggersHealthToast()); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="warning"
        sx={{
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          maxWidth: 440,
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
              onClick={() => dispatch(hideTriggersHealthToast())}
              sx={{ color: c.text.muted, ml: 0.25, '&:hover': { color: c.text.primary } }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </>
        }
      >
        {first ? `A watcher on "${first.workflow_title}" keeps failing (${first.consecutive_failures} in a row)${extra}; it may need something from you.` : ''}
      </Alert>
    </Snackbar>
  );
}
