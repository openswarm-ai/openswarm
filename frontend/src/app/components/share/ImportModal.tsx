// Import side of .swarm: preflight shows what's inside (and any environment
// requirements as informational "Needs X" rows), then commit writes the
// entities with fresh ids and we navigate to the imported root. Requirements in
// v1 are informational only; the live "enable this Action" walkthrough lands
// with the app/dashboard slices, so we never imply a grant we don't perform.
import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';

import IncludesList from './IncludesList';
import { importCommit, importPreflight } from './shareApi';
import { ImportPreflight } from './shareTypes';

interface Props {
  file: File | null;
  open: boolean;
  onClose: () => void;
}

const DEST: Record<string, (id: string) => string> = {
  app: (id) => `/apps/${id}`,
  dashboard: (id) => `/dashboard/${id}`,
  skill: () => '/skills',
};

const ImportModal: React.FC<Props> = ({ file, open, onClose }) => {
  const c = useClaudeTokens();
  const navigate = useNavigate();
  const [preflight, setPreflight] = useState<ImportPreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);

  const load = useCallback(() => {
    if (!file) return undefined;
    setPreflight(null);
    setError('');
    setLoading(true);
    let alive = true;
    importPreflight(file)
      .then((pf) => alive && setPreflight(pf))
      .catch((e) => alive && setError(e?.message || "We couldn't read this file."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [file]);

  useEffect(() => {
    if (!open) return;
    return load();
  }, [open, load]);

  const handleCommit = async () => {
    if (!preflight) return;
    setCommitting(true);
    try {
      const result = await importCommit(preflight.staging_token);
      const dest = (DEST[result.root_type] || (() => '/skills'))(result.root_id);
      onClose();
      navigate(dest);
    } catch (e: any) {
      setError(e?.message || "We couldn't finish the import.");
    } finally {
      setCommitting(false);
    }
  };

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
            Import {preflight ? preflight.summary.root.name : ''}
          </Typography>
          <IconButton size="small" onClick={onClose} sx={{ color: c.text.tertiary }}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>

        <Box sx={{ px: 3, pb: 3 }}>
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
            </Box>
          ) : preflight ? (
            <>
              <IncludesList summary={preflight.summary} />
              {preflight.review && preflight.review.findings.length > 0 && (
                <Box
                  sx={{
                    mt: 1.5,
                    p: 1.5,
                    borderRadius: `${c.radius.md}px`,
                    border: `1px solid ${c.status.warning}55`,
                    bgcolor: c.status.warningBg,
                  }}
                >
                  {preflight.review.findings.map((f, i) => (
                    <Typography key={`rv-${i}`} sx={{ fontSize: '0.78rem', color: c.text.secondary, lineHeight: 1.5 }}>
                      {f}
                    </Typography>
                  ))}
                </Box>
              )}
              {preflight.conflicts.length > 0 && (
                <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mt: 1.5 }}>
                  Some items already exist and will be added as copies.
                </Typography>
              )}
              {preflight.warnings.map((w, i) => (
                <Typography key={`w-${i}`} sx={{ fontSize: '0.78rem', color: c.text.muted, mt: 0.5 }}>
                  {w}
                </Typography>
              ))}
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                <Button
                  variant="contained"
                  onClick={handleCommit}
                  disabled={committing}
                  startIcon={committing ? <CircularProgress size={14} sx={{ color: c.text.inverse }} /> : undefined}
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
                  Add to OpenSwarm
                </Button>
              </Box>
            </>
          ) : null}
        </Box>
      </Dialog>

      <Snackbar
        open={!!error && !open}
        autoHideDuration={4000}
        onClose={() => setError('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" variant="outlined" sx={{ bgcolor: c.bg.surface, color: c.text.primary }}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
};

export default ImportModal;
