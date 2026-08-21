// The fn/Globe key is the default dictation trigger and only the native watcher can see it, so a
// missing Input Monitoring grant used to leave a key that did nothing, forever, with nothing said.
// This is the surface for that: name the chord that works right now, and offer the pane that fixes it.

import React from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';

type Issue = { ok: boolean; reason?: string; fallback?: string };

const PRETTY: Record<string, string> = {
  'input-monitoring-denied': 'OpenSwarm does not have Input Monitoring permission',
  'tap-deaf': 'the fn key is not reaching OpenSwarm',
  'no-watcher-binary': 'the fn key helper is missing',
};

export default function VoiceHotkeyToast() {
  const [issue, setIssue] = React.useState<Issue | null>(null);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    const api = (window as any).openswarm;
    if (!api || typeof api.onVoiceHotkeyIssue !== 'function') return;
    // Ask first: arming happens before this mounts, so subscribing alone would miss the only send.
    api.getVoiceHotkeyIssue?.().then((known: Issue | null) => {
      if (known && known.ok === false) setIssue(known);
    }).catch(() => {});
    return api.onVoiceHotkeyIssue((next: Issue) => {
      // A key that starts working must retract its own warning, not keep crying wolf.
      if (next.ok) { setIssue(null); setDismissed(false); return; }
      setIssue(next);
    });
  }, []);

  if (!issue || dismissed) return null;

  const why = PRETTY[issue.reason || ''] || 'the fn key is unavailable';
  const chord = (issue.fallback || 'Meta+Shift+D').replace('Meta', '⌘').replace('Shift', '⇧').replace(/\+/g, '');
  const canFix = issue.reason === 'input-monitoring-denied';

  return (
    <Snackbar
      open
      autoHideDuration={null}
      onClose={(_e, reason) => { if (reason !== 'clickaway') setDismissed(true); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="warning"
        action={
          <>
            {canFix && (
              <Button
                size="small"
                onClick={() => { (window as any).openswarm?.openInputMonitoringSettings?.(); setDismissed(true); }}
              >
                Open Settings
              </Button>
            )}
            <IconButton size="small" aria-label="Dismiss" onClick={() => setDismissed(true)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      >
        Dictation: {why}. Use <strong>{chord}</strong> for now.
      </Alert>
    </Snackbar>
  );
}
