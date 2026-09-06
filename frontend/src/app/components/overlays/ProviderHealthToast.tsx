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
import { openSettingsCard } from '@/shared/state/dashboardLayoutSlice';
import { healthToastAnchor, type HealthToastAnchor } from '@/app/pages/Dashboard/canvas/spawnPillCover';

// Where the toast would sit at its bottom-left home (MUI's 24 px inset), so a toast already moved up is judged on the spot it came from.
function HOME_RECT(r: DOMRect): { x: number; y: number; w: number; h: number } {
  return { x: 24, y: window.innerHeight - 24 - r.height, w: r.width, h: r.height };
}

export default function ProviderHealthToast() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.subscriptions.healthToastOpen);
  const dead = useAppSelector((s) => s.subscriptions.healthDead);
  const cliMissing = useAppSelector((s) => s.subscriptions.healthCliMissing);
  const tiledZonesKey = useAppSelector((s) => Object.values(s.dashboardLayout.tiledCards).sort().join(','));
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = React.useState<HealthToastAnchor>({ vertical: 'bottom', horizontal: 'left' });
  React.useLayoutEffect(() => {
    // Measured at its home spot, never at the moved one, or a toast that moved up would never come back down.
    const el = rootRef.current;
    if (!el || !open) return;
    const r = el.getBoundingClientRect();
    const zones = tiledZonesKey ? tiledZonesKey.split(',') : [];
    setAnchor(healthToastAnchor(zones, anchor.vertical === 'bottom' ? { x: r.x, y: r.y, w: r.width, h: r.height } : HOME_RECT(r)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiledZonesKey, open]);

  const onReconnect = React.useCallback(() => {
    dispatch(openSettingsCard({ tab: 'models' }));
    dispatch(hideProviderHealthToast());
  }, [dispatch]);

  // Defensive dedupe: duplicate provider rows upstream once rendered "ChatGPT and ChatGPT".
  const labels = Array.from(new Set(dead.map((d) => d.label))).join(' and ');

  return (
    <Snackbar
      open={open && (dead.length > 0 || cliMissing)}
      autoHideDuration={null}
      // Clickaway would kill the pill on the user's first canvas click, before they read it; only the X or Reconnect dismisses.
      onClose={(event, reason) => { if (reason !== 'clickaway') dispatch(hideProviderHealthToast()); }}
      anchorOrigin={anchor}
      ref={rootRef}
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
            {dead.length > 0 && (
              <Button size="small" onClick={onReconnect} sx={{ color: c.accent.primary, fontWeight: 700 }}>
                Reconnect
              </Button>
            )}
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
        {cliMissing
          ? 'A core OpenSwarm component is missing, usually antivirus quarantine. Restore it from quarantine and add an exclusion for OpenSwarm, or reinstall from openswarm.com; agents cannot run until then.'
          : `Your ${labels} login${dead.length > 1 ? 's have' : ' has'} expired; chats on ${dead.length > 1 ? 'them' : 'it'} will fail until you reconnect.`}
      </Alert>
    </Snackbar>
  );
}
