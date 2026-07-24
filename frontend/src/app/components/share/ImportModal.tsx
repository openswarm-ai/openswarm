// Confirmation surface shown only for bundles that carry something with a consequence (an app that runs code, or actions that must be connected). Safe bundles never reach here; the entry point auto-imports them. This is purely presentational: the entry point owns preflight, commit, and navigation.
import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';

import IncludesList from './IncludesList';
import { ImportPreflight } from './shareTypes';

interface Props {
  preflight: ImportPreflight | null;
  open: boolean;
  committing: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

const ImportModal: React.FC<Props> = ({ preflight, open, committing, onConfirm, onClose }) => {
  const c = useClaudeTokens();
  return (
    <Dialog
      open={open && !!preflight}
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
      {preflight && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, pt: 2.5, pb: 1 }}>
            <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>
              Add {preflight.summary.root.name}?
            </Typography>
            <IconButton size="small" onClick={onClose} sx={{ color: c.text.tertiary }}>
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>
          <Box sx={{ px: 3, pb: 3 }}>
            <IncludesList summary={preflight.summary} />
            {preflight.review && preflight.review.findings.length > 0 && (
              <Box sx={{ mt: 1.75, display: 'flex', gap: 0.85, alignItems: 'center' }}>
                <ShieldOutlinedIcon sx={{ fontSize: 15, color: c.status.warning, flexShrink: 0 }} />
                <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, lineHeight: 1.4 }}>
                  {preflight.review.findings.join(' ')}
                </Typography>
              </Box>
            )}
            {preflight.conflicts.length > 0 && (
              <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mt: 1.5 }}>
                Some items already exist and will be added as copies.
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
              <Button onClick={onClose} sx={{ textTransform: 'none', color: c.text.secondary }}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={onConfirm}
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
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  boxShadow: 'none',
                }}
              >
                Add to OpenSwarm
              </Button>
            </Box>
          </Box>
        </>
      )}
    </Dialog>
  );
};

export default ImportModal;
