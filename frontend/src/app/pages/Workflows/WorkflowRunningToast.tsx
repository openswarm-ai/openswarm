// Clickable "your {workflow} is running now" nudge for scheduled runs that
// fire while the user isn't looking. Detection lives in the upsertRun reducer
// (it owns the into-running edge); this just renders the redux toast state and,
// on View, jumps the canvas to the workflow, opening its live conversation if
// it wasn't already on screen.

import React from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import { dismissRunningToast, openWorkflowCard, type OpenCard } from '@/shared/state/workflowsSlice';
import { addWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { useOpenSidecar } from './WorkflowCardLiveViews';

export default function WorkflowRunningToast() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const toast = useAppSelector((s) => s.workflows.runningToast);
  const openSidecar = useOpenSidecar(toast?.workflowId || '');

  const onView = React.useCallback(() => {
    if (!toast) return;
    const { workflowId, runId } = toast;
    const st = store.getState();
    const alreadyOpen = Boolean(st.dashboardLayout.workflowCards[workflowId]);
    // addWorkflowCard pans the canvas to the card whether it already exists or
    // gets created here (both set pendingFocusWorkflowId for the lifecycle hook).
    dispatch(addWorkflowCard({ workflowId }));
    if (!alreadyOpen) {
      const run = st.workflows.runs[workflowId]?.find((r) => r.id === runId);
      const status = run?.status;
      const view: OpenCard['view'] = status === 'failure' ? 'failed'
        : (status === 'success' || status === 'ran_late') ? 'completed' : 'running';
      dispatch(openWorkflowCard({ workflowId, view, runId }));
      if (run?.session_id) {
        const kind = status === 'failure' ? 'viewing-error'
          : (status === 'success' || status === 'ran_late') ? 'viewing-completed' : 'watching';
        void openSidecar(run.session_id, kind);
      }
    }
    dispatch(dismissRunningToast());
  }, [toast, dispatch, openSidecar]);

  return (
    <Snackbar
      open={Boolean(toast)}
      autoHideDuration={10000}
      onClose={(_, reason) => { if (reason !== 'clickaway') dispatch(dismissRunningToast()); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="info"
        onClose={() => dispatch(dismissRunningToast())}
        sx={{
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          '& .MuiAlert-action': { alignItems: 'center', pt: 0 },
        }}
        action={
          <Button size="small" onClick={onView} sx={{ color: c.accent.primary, fontWeight: 700 }}>
            View
          </Button>
        }
      >
        {toast ? `${toast.workflowTitle} is running now` : ''}
      </Alert>
    </Snackbar>
  );
}
