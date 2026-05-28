import React from 'react';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const ConfirmDiscardDialog: React.FC<{ open: boolean; onCancel: () => void; onConfirm: () => void }> = ({ open, onCancel, onConfirm }) => {
  const c = useClaudeTokens();
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      PaperProps={{
        sx: {
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          maxWidth: 380,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', pb: 0.5, px: 3, pt: 2.5 }}>
        Discard unsaved changes?
      </DialogTitle>
      <DialogContent sx={{ px: 3 }}>
        <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>
          Your in-progress edits will be cleared and the form will revert to your saved settings. This can&apos;t be undone.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          onClick={onCancel}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Keep editing
        </Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          sx={{
            bgcolor: c.status.error,
            color: '#fff',
            '&:hover': { bgcolor: c.status.error, filter: 'brightness(0.9)' },
            textTransform: 'none',
            borderRadius: 1.5,
            fontSize: '0.85rem',
          }}
        >
          Discard
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ConfirmDiscardDialog;
