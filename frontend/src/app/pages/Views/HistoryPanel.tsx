import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import Fade from '@mui/material/Fade';
import RestoreIcon from '@mui/icons-material/Restore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import HistoryIcon from '@mui/icons-material/History';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  OutputVersion,
  fetchOutputVersions,
  captureOutputVersion,
  restoreOutputVersion,
  branchOutputVersion,
  fetchOutputs,
} from '@/shared/state/outputsSlice';

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function describe(v: OutputVersion): string {
  const label = v.label?.trim();
  if (label) return label;
  if (v.source === 'manual') return 'Saved version';
  return 'Updated the app';
}

interface Props {
  outputId: string;
  /** Disable changes while the builder is mid-edit, so a restore can't race a write. */
  isAgentActive?: boolean;
  /** Default name for a manual save (the user's last request makes a nice one). */
  saveLabel?: string;
  /** Fired after a branch so the parent can open / surface the new copy. */
  onBranched?: (newId: string) => void;
  /** Fired after a restore so the editor can refresh its files + preview now. */
  onRestored?: () => void;
}

const HistoryPanel: React.FC<Props> = ({ outputId, isAgentActive, saveLabel, onBranched, onRestored }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  // Refetch when a build (or manual save) captures a new version while we're open.
  const captureSignal = useAppSelector((s) => s.outputs.captureSignal[outputId] ?? 0);

  const [versions, setVersions] = useState<OutputVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    if (!mountedRef.current) return;
    setStatus({ kind, text });
    window.setTimeout(() => { if (mountedRef.current) setStatus(null); }, 3500);
  }, []);

  // alive-guarded so a slower fetch for a previous outputId (or after close) can't overwrite the list. Handlers bump reloadKey to refetch.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    dispatch(fetchOutputVersions(outputId)).unwrap()
      .then((list) => { if (alive) setVersions(list); })
      .catch(() => { /* a missing history just shows the empty state */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dispatch, outputId, reloadKey, captureSignal]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // No reloadKey bump: captureOutputVersion.fulfilled bumps captureSignal, which already drives the refetch. Bumping both = a double fetch.
      await dispatch(captureOutputVersion({ id: outputId, source: 'manual', label: saveLabel || '' })).unwrap();
      flash('ok', 'Saved this version.');
    } catch {
      flash('err', "Couldn't save this version. Try again.");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [dispatch, outputId, saveLabel, flash]);

  const handleRestore = useCallback(async (versionId: string) => {
    setConfirmId(null);
    setBusyId(versionId);
    try {
      await dispatch(restoreOutputVersion({ id: outputId, versionId })).unwrap();
      setReloadKey((k) => k + 1);
      onRestored?.();
      flash('ok', 'Brought your app back to this version.');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Could not restore that version.');
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  }, [dispatch, outputId, flash, onRestored]);

  const handleBranch = useCallback(async (versionId: string) => {
    setBusyId(versionId);
    try {
      const newId = await dispatch(branchOutputVersion({ id: outputId, versionId })).unwrap();
      await dispatch(fetchOutputs());
      flash('ok', 'Saved as a new app.');
      onBranched?.(newId);
    } catch {
      flash('err', "Couldn't make a copy. Try again.");
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  }, [dispatch, outputId, onBranched, flash]);

  const confirmTarget = versions.find((v) => v.id === confirmId) || null;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1.25, gap: 1 }}>
        <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: c.text.primary }}>History</Typography>
        <Button
          size="small"
          startIcon={<BookmarkAddOutlinedIcon sx={{ fontSize: 16 }} />}
          onClick={handleSave}
          disabled={saving || isAgentActive}
          sx={{ textTransform: 'none', fontSize: '0.75rem', color: c.accent.primary, '&:hover': { bgcolor: `${c.accent.primary}12` } }}
        >
          {saving ? 'Saving' : 'Save this version'}
        </Button>
      </Box>

      <Fade in={!!status} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
        <Box sx={{
          mx: 1.5, mb: 1, px: 1.25, py: 0.75, borderRadius: 2, fontSize: '0.8125rem',
          color: status?.kind === 'err' ? c.status.error : c.text.secondary,
          bgcolor: status?.kind === 'err' ? `${c.status.error}14` : `${c.accent.primary}12`,
        }}>
          {status?.text}
        </Box>
      </Fade>

      <Box sx={{ flex: 1, overflowY: 'auto', px: 1.5, pb: 2 }}>
        {loading && versions.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
            <CircularProgress size={22} sx={{ color: c.text.tertiary }} />
          </Box>
        ) : versions.length === 0 ? (
          <Box sx={{ textAlign: 'center', pt: 6, px: 2 }}>
            <HistoryIcon sx={{ fontSize: 34, color: c.text.tertiary, opacity: 0.5, mb: 1 }} />
            <Typography sx={{ fontSize: '0.875rem', color: c.text.muted, lineHeight: 1.5 }}>
              No history yet. Every time you change your app, we'll save a snapshot here so you can go back.
            </Typography>
          </Box>
        ) : (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: c.accent.primary, flexShrink: 0 }} />
              <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, color: c.text.secondary }}>Now (current)</Typography>
            </Box>
            {versions.map((v) => (
              <Box
                key={v.id}
                sx={{
                  display: 'flex', gap: 1.25, p: 1, borderRadius: 2, alignItems: 'center',
                  border: `1px solid ${c.border.subtle}`, mb: 0.75, bgcolor: c.bg.surface,
                  '&:hover': { borderColor: c.border.medium },
                }}
              >
                <Box sx={{
                  width: 64, height: 44, borderRadius: 1.5, flexShrink: 0, overflow: 'hidden',
                  bgcolor: c.bg.secondary, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {v.thumbnail
                    ? <Box component="img" src={v.thumbnail} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left' }} />
                    : <HistoryIcon sx={{ fontSize: 18, color: c.text.tertiary, opacity: 0.5 }} />}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {describe(v)}
                  </Typography>
                  <Typography sx={{ fontSize: '0.75rem', color: c.text.muted }}>
                    {timeAgo(v.created_at)}{v.source === 'manual' ? ' · saved by you' : v.source === 'pre_restore' ? ' · auto-backup' : ''}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                  <Button
                    size="small"
                    startIcon={busyId === v.id ? <CircularProgress size={13} /> : <RestoreIcon sx={{ fontSize: 15 }} />}
                    onClick={() => setConfirmId(v.id)}
                    disabled={!!busyId || isAgentActive}
                    sx={{ textTransform: 'none', fontSize: '0.75rem', color: c.text.secondary, minWidth: 0, '&:hover': { bgcolor: `${c.text.primary}08` } }}
                  >
                    Restore
                  </Button>
                  <Button
                    size="small"
                    startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
                    onClick={() => handleBranch(v.id)}
                    disabled={!!busyId}
                    sx={{ textTransform: 'none', fontSize: '0.75rem', color: c.text.secondary, minWidth: 0, '&:hover': { bgcolor: `${c.text.primary}08` } }}
                  >
                    Save as new app
                  </Button>
                </Box>
              </Box>
            ))}
          </>
        )}
      </Box>

      <Dialog open={!!confirmTarget} onClose={() => setConfirmId(null)} PaperProps={{ sx: { borderRadius: 3, bgcolor: c.bg.surface, p: 0.5, maxWidth: 380 } }}>
        <Box sx={{ p: 2.5 }}>
          <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: c.text.primary, mb: 1 }}>
            Go back to this version?
          </Typography>
          <Typography sx={{ fontSize: '0.8125rem', color: c.text.muted, lineHeight: 1.5, mb: 2.5 }}>
            This brings your app back to how it was here. Your current version is saved first, so you can always come back.
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button onClick={() => setConfirmId(null)} sx={{ textTransform: 'none', color: c.text.secondary }}>Cancel</Button>
            <Button
              variant="contained" disableElevation
              onClick={() => confirmTarget && handleRestore(confirmTarget.id)}
              sx={{ textTransform: 'none', bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.primary } }}
            >
              Go back to this version
            </Button>
          </Box>
        </Box>
      </Dialog>
    </Box>
  );
};

export default HistoryPanel;
