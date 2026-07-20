// Anthropic-style Share modal. v1 ships one real action, Download .swarm; the "Create share link" row is shown but disabled (that hosted-link flow is v2).
import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import LinkIcon from '@mui/icons-material/Link';
import PublicIcon from '@mui/icons-material/Public';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';

import IncludesList from './IncludesList';
import PublishModal from './PublishModal';
import { downloadSwarm, exportPreflight } from './shareApi';
import { ExportPreflight, ShareTarget } from './shareTypes';

interface Props {
  target: ShareTarget;
  open: boolean;
  onClose: () => void;
}

const ShareModal: React.FC<Props> = ({ target, open, onClose }) => {
  const c = useClaudeTokens();
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);

  const load = useCallback(() => {
    setPreflight(null);
    setError('');
    setLoading(true);
    let alive = true;
    exportPreflight(target)
      .then((pf) => alive && setPreflight(pf))
      .catch((e) => alive && setError(e?.message || "We couldn't read this for sharing."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [target.kind, target.id]);

  useEffect(() => {
    if (!open) return;
    return load();
  }, [open, load]);

  const handleDownload = async (allowSecrets = false) => {
    if (!preflight) return;
    setDownloading(true);
    try {
      await downloadSwarm(target, preflight.filename, allowSecrets);
      setToast(`Saved ${preflight.filename}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || "We couldn't build the file.");
    } finally {
      setDownloading(false);
    }
  };
  // The file-content secret heuristic is overridable (download goes to people you trust); our own credential fields ("secret-shaped field(s)") are not.
  const secretOverridable = error.includes('secret-shaped value');

  const optionRow = (
    selected: boolean,
    icon: React.ReactNode,
    title: string,
    subtitle: string,
    disabled?: boolean,
    chip?: string,
    onClick?: () => void,
  ) => (
    <Box
      onClick={!disabled && onClick ? onClick : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1.5,
        mb: 1,
        borderRadius: `${c.radius.md}px`,
        border: `1px solid ${selected ? c.accent.primary : c.border.subtle}`,
        bgcolor: selected ? `${c.accent.primary}0d` : 'transparent',
        opacity: disabled ? 0.5 : 1,
        cursor: !disabled && onClick ? 'pointer' : 'default',
        transition: 'background-color 0.12s, border-color 0.12s',
        '&:hover': !disabled && onClick ? { bgcolor: c.bg.secondary, borderColor: c.border.medium } : undefined,
      }}
    >
      <Box sx={{ color: selected ? c.accent.primary : c.text.tertiary, display: 'flex' }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: '0.88rem', fontWeight: 600, color: c.text.primary }}>{title}</Typography>
          {chip && (
            <Chip
              label={chip}
              size="small"
              sx={{ height: 18, fontSize: '0.62rem', bgcolor: c.bg.secondary, color: c.text.muted }}
            />
          )}
        </Box>
        <Typography sx={{ fontSize: '0.78rem', color: c.text.muted }}>{subtitle}</Typography>
      </Box>
    </Box>
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth={false}
        PaperProps={{
          sx: {
            width: 440,
            maxWidth: '92vw',
            bgcolor: c.bg.page,
            borderRadius: `${c.radius.xl}px`,
            border: `1px solid ${c.border.subtle}`,
            boxShadow: c.shadow.lg,
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, pt: 2.5, pb: 1 }}>
          <Typography sx={{ fontSize: '1.05rem', fontWeight: 700, color: c.text.primary }}>
            Share {target.name}
          </Typography>
          <IconButton size="small" onClick={onClose} sx={{ color: c.text.tertiary }}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>

        <Box sx={{ px: 3, pb: 3 }}>
          <Box sx={{ mb: 2 }}>
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress size={20} sx={{ color: c.accent.primary }} />
              </Box>
            ) : error ? (
              <Box sx={{ py: 1 }}>
                <Typography sx={{ fontSize: '0.85rem', color: c.text.secondary, mb: 1 }}>{error}</Typography>
                <Button size="small" onClick={load} sx={{ textTransform: 'none', color: c.accent.primary }}>
                  Try again
                </Button>
                {secretOverridable && (
                  <Button
                    size="small"
                    onClick={() => { setError(''); handleDownload(true); }}
                    disabled={downloading}
                    sx={{ textTransform: 'none', color: c.status.error, ml: 1 }}
                  >
                    Export anyway (includes the flagged value; only send to people you trust)
                  </Button>
                )}
              </Box>
            ) : preflight ? (
              <IncludesList summary={preflight.summary} />
            ) : null}
          </Box>

          {optionRow(true, <DownloadIcon sx={{ fontSize: 20 }} />, 'Download .swarm file', 'Save a file you can send to anyone.')}
          {target.kind === 'app'
            ? optionRow(
                false,
                <PublicIcon sx={{ fontSize: 20 }} />,
                'Publish to web',
                'A public link anyone can open, hosted at openswarm.host.',
                false,
                undefined,
                () => setPublishOpen(true),
              )
            : optionRow(
                false,
                <LinkIcon sx={{ fontSize: 20 }} />,
                'Create share link',
                'A link that opens straight in OpenSwarm.',
                true,
                'Coming soon',
              )}

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
            <Button
              variant="contained"
              onClick={() => handleDownload()}
              disabled={!preflight || downloading}
              startIcon={
                downloading ? (
                  <CircularProgress size={14} sx={{ color: c.text.inverse }} />
                ) : (
                  <DownloadIcon sx={{ fontSize: 16 }} />
                )
              }
              sx={{
                bgcolor: c.accent.primary,
                '&:hover': { bgcolor: c.accent.pressed },
                '&.Mui-disabled': { bgcolor: c.border.medium, color: c.text.muted },
                textTransform: 'none',
                borderRadius: `${c.radius.md}px`,
                px: 2.5,
                py: 0.6,
                fontSize: '0.85rem',
                fontWeight: 600,
                boxShadow: 'none',
              }}
            >
              Download .swarm
            </Button>
          </Box>
        </Box>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          variant="outlined"
          onClose={() => setToast('')}
          sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.border.medium}`, fontSize: '0.82rem' }}
        >
          {toast}
        </Alert>
      </Snackbar>

      {target.kind === 'app' && (
        <PublishModal
          outputId={target.id}
          outputName={target.name}
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
        />
      )}
    </>
  );
};

export default ShareModal;
