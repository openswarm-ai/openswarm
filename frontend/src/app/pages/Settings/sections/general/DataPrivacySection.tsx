import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import TextField from '@mui/material/TextField';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import type { SettingsStyles } from '../settingsStyles';

const ERASE_WORD = 'ERASE';

// The iOS Reset menu, two actions only: "Reset All Settings" (preferences back to defaults, your stuff + sign-in stay) and "Erase All Content and Settings" (factory wipe + relaunch). Flat rows, not a boxed "danger zone": red lives only on the destructive label, and the real friction is the typed-confirm in the dialog.
const DataPrivacySection: React.FC<{ styles: SettingsStyles }> = ({ styles }) => {
  const c = useClaudeTokens();
  const { sectionSx, labelSx, descSx } = styles;

  const [resetOpen, setResetOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [eraseText, setEraseText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearedOk, setClearedOk] = useState(false);

  const closeAll = () => {
    if (busy) return;
    setResetOpen(false);
    setEraseOpen(false);
    setClearOpen(false);
    setClearedOk(false);
    setEraseText('');
    setErr(null);
  };

  const doReset = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/settings/reset-to-defaults`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      // Reload so every slice + local component state re-syncs from the now-default backend; no stale flag can survive a full renderer reload.
      window.location.reload();
    } catch {
      setBusy(false);
      setErr("Couldn't reset just now. Try again in a moment.");
    }
  };

  const doErase = async () => {
    const api = window.openswarm;
    if (!api?.hardReset) {
      setErr('This only works in the desktop app.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.hardReset(); // the app exits + relaunches, so this normally never resolves.
    } catch {
      setBusy(false);
      setErr("Couldn't erase just now. Try again in a moment.");
    }
  };

  const doClearBrowser = async () => {
    const api = window.openswarm;
    if (!api?.clearBrowserData) {
      setErr('This only works in the desktop app.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.clearBrowserData();
      setBusy(false);
      setClearedOk(true);
    } catch {
      setBusy(false);
      setErr("Couldn't clear browsing data just now. Try again in a moment.");
    }
  };

  const dialogPaperSx = {
    bgcolor: c.bg.surface,
    border: `1px solid ${c.border.subtle}`,
    borderRadius: 2.5,
    maxWidth: 360,
  };
  const titleSx = { color: c.text.primary, fontSize: '1rem', fontWeight: 600, mb: 1 };
  const bodySx = { color: c.text.secondary, fontSize: '0.8125rem', lineHeight: 1.5, mb: 2 };
  const errSx = { color: c.status.error, fontSize: '0.75rem', mb: 1.5 };
  const cancelSx = { color: c.text.secondary, textTransform: 'none', fontWeight: 500 };
  const actionRowSx = { display: 'flex', justifyContent: 'flex-end', gap: 1 };

  // Match the About-section outlined buttons (Restart tour / Check for Updates).
  const rowBtnSx = {
    color: c.text.secondary,
    borderColor: c.border.medium,
    textTransform: 'none' as const,
    fontSize: '0.8125rem',
    whiteSpace: 'nowrap' as const,
    '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
  };
  const eraseBtnSx = {
    ...rowBtnSx,
    color: c.status.error,
    borderColor: c.status.error,
    '&:hover': { color: c.status.error, borderColor: c.status.error, bgcolor: c.status.errorBg },
  };
  const rowSx = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3, py: 2 };

  return (
    <Box>
      <Typography sx={{ ...sectionSx, mt: 3 }}>Data &amp; Privacy</Typography>

      <Box sx={{ ...rowSx, borderBottom: `1px solid ${c.border.subtle}` }}>
        <Box>
          <Typography sx={labelSx}>Reset all settings</Typography>
          <Typography sx={descSx}>Puts your preferences back to defaults. Your apps, chats, skills, and sign-in stay.</Typography>
        </Box>
        <Button variant="outlined" size="small" onClick={() => { setErr(null); setResetOpen(true); }} sx={rowBtnSx}>Reset</Button>
      </Box>

      <Box sx={{ ...rowSx, borderBottom: `1px solid ${c.border.subtle}` }}>
        <Box>
          <Typography sx={labelSx}>Clear browsing data</Typography>
          <Typography sx={descSx}>Signs you out of sites opened in browser cards and clears their cookies, cache, and local storage. Your chats, apps, and settings stay.</Typography>
        </Box>
        <Button variant="outlined" size="small" onClick={() => { setErr(null); setClearedOk(false); setClearOpen(true); }} sx={rowBtnSx}>Clear</Button>
      </Box>

      <Box sx={rowSx}>
        <Box>
          <Typography sx={{ ...labelSx, color: c.status.error }}>Erase all content and settings</Typography>
          <Typography sx={descSx}>Removes every chat, app, skill, and setting and restarts OpenSwarm fresh. This can't be undone.</Typography>
        </Box>
        <Button variant="outlined" size="small" onClick={() => { setErr(null); setEraseText(''); setEraseOpen(true); }} sx={eraseBtnSx}>Erase</Button>
      </Box>

      <Dialog open={resetOpen} onClose={closeAll} PaperProps={{ sx: dialogPaperSx }}>
        <Box sx={{ p: 2.5 }}>
          <Typography sx={titleSx}>Reset all settings?</Typography>
          <Typography sx={bodySx}>Your preferences go back to defaults. Apps, chats, skills, and sign-in stay.</Typography>
          {err && <Typography sx={errSx}>{err}</Typography>}
          <Box sx={actionRowSx}>
            <Button onClick={closeAll} disabled={busy} sx={cancelSx}>Cancel</Button>
            <Button onClick={doReset} disabled={busy} sx={{ color: c.accent.primary, textTransform: 'none', fontWeight: 600 }}>{busy ? 'Resetting…' : 'Reset'}</Button>
          </Box>
        </Box>
      </Dialog>

      <Dialog open={clearOpen} onClose={closeAll} PaperProps={{ sx: dialogPaperSx }}>
        <Box sx={{ p: 2.5 }}>
          <Typography sx={titleSx}>{clearedOk ? 'Browsing data cleared' : 'Clear browsing data?'}</Typography>
          <Typography sx={bodySx}>{clearedOk ? 'Cookies, cache, and local storage for browser cards are gone. Reload a browser card to see it signed out.' : 'This signs you out of sites in browser cards and clears their cookies, cache, and local storage. Your chats, apps, and settings stay.'}</Typography>
          {err && <Typography sx={errSx}>{err}</Typography>}
          <Box sx={actionRowSx}>
            {clearedOk ? (
              <Button onClick={closeAll} sx={{ color: c.accent.primary, textTransform: 'none', fontWeight: 600 }}>Done</Button>
            ) : (
              <>
                <Button onClick={closeAll} disabled={busy} sx={cancelSx}>Cancel</Button>
                <Button onClick={doClearBrowser} disabled={busy} sx={{ color: c.accent.primary, textTransform: 'none', fontWeight: 600 }}>{busy ? 'Clearing…' : 'Clear'}</Button>
              </>
            )}
          </Box>
        </Box>
      </Dialog>

      <Dialog open={eraseOpen} onClose={closeAll} PaperProps={{ sx: dialogPaperSx }}>
        <Box sx={{ p: 2.5 }}>
          <Typography sx={titleSx}>Erase all content and settings?</Typography>
          <Typography sx={bodySx}>This deletes every chat, app, skill, and setting, then restarts OpenSwarm. It can't be undone.</Typography>
          <TextField
            value={eraseText}
            onChange={(e) => setEraseText(e.target.value)}
            placeholder={`Type ${ERASE_WORD} to confirm`}
            fullWidth
            size="small"
            autoFocus
            disabled={busy}
            sx={{ mb: 2, '& .MuiOutlinedInput-root': { fontSize: '0.8125rem' } }}
          />
          {err && <Typography sx={errSx}>{err}</Typography>}
          <Box sx={actionRowSx}>
            <Button onClick={closeAll} disabled={busy} sx={cancelSx}>Cancel</Button>
            <Button onClick={doErase} disabled={busy || eraseText.trim() !== ERASE_WORD} sx={{ color: c.status.error, textTransform: 'none', fontWeight: 600 }}>{busy ? 'Erasing…' : 'Erase'}</Button>
          </Box>
        </Box>
      </Dialog>
    </Box>
  );
};

export default DataPrivacySection;
