import React, { useCallback, useState } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { deleteSession } from '@/shared/state/agentsSlice';
import { removeCard } from '@/shared/state/dashboardLayoutSlice';
import { clearPrepped } from '@/shared/state/onboardingV3Slice';

const RESOLVED_KEY = 'openswarm.prep-keep.v1';

function alreadyResolved(): boolean {
  try { return localStorage.getItem(RESOLVED_KEY) !== null; } catch { return false; }
}

// Accept-or-deny for the work onboarding started on the user's behalf: keep dismisses, discard stops and deletes the prepped sessions. One-shot per install; nothing the flow prepped is forced on anyone.
const PrepKeepToast: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [resolved, setResolved] = useState(alreadyResolved);
  const prepped = useAppSelector((s) => s.onboardingV3.prepped);
  const flowActive = useAppSelector((s) => s.onboardingV3.flowActive);
  const revealPending = useAppSelector((s) => s.onboardingV3.revealPending);

  const finish = useCallback(() => {
    try { localStorage.setItem(RESOLVED_KEY, new Date().toISOString()); } catch {}
    dispatch(clearPrepped());
    setResolved(true);
  }, [dispatch]);

  const discard = useCallback(() => {
    for (const job of prepped) {
      dispatch(removeCard(job.sessionId));
      void dispatch(deleteSession({ sessionId: job.sessionId }));
    }
    finish();
  }, [prepped, dispatch, finish]);

  const names = prepped.map((j) => j.title).join(' and ');

  return (
    <Snackbar
      open={!resolved && !flowActive && !revealPending && prepped.length > 0}
      autoHideDuration={null}
      onClose={(event, reason) => { if (reason !== 'clickaway') finish(); }}
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
            <Button size="small" onClick={finish} sx={{ color: c.accent.primary, fontWeight: 700 }}>
              Keep them
            </Button>
            <Button size="small" onClick={discard} sx={{ color: c.text.tertiary }}>
              Stop &amp; remove
            </Button>
          </>
        }
      >
        {`These are ${names}, which I started for you during setup. Keep them, or stop and remove them?`}
      </Alert>
    </Snackbar>
  );
};

export default PrepKeepToast;
