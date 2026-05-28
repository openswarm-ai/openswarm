import React from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const CloseAgentDialog: React.FC<Props> = ({ open, onCancel, onConfirm }) => {
  const c = useClaudeTokens();
  return (
  <Dialog
    open={open}
    onClose={onCancel}
    PaperProps={{
      sx: {
        bgcolor: c.bg.surface,
        borderRadius: 4,
        border: `1px solid ${c.border.subtle}`,
        minWidth: 380,
      },
    }}
  >
    <DialogTitle sx={{ color: c.status.warning, fontWeight: 700, fontSize: '1rem', pb: 0.5 }}>
      Agent still running
    </DialogTitle>
    <DialogContent>
      <DialogContentText sx={{ color: c.text.muted, fontSize: '0.875rem' }}>
        This agent is still running. Closing it will pause the agent.
        You can resume it later from the chat history.
      </DialogContentText>
    </DialogContent>
    <DialogActions sx={{ px: 3, pb: 2 }}>
      <Button onClick={onCancel} sx={{ color: c.text.tertiary }}>
        Cancel
      </Button>
      <Button
        onClick={onConfirm}
        variant="contained"
        sx={{
          bgcolor: c.status.warning,
          '&:hover': { bgcolor: '#6b4a18' },
          fontWeight: 600,
        }}
      >
        Close &amp; Pause
      </Button>
    </DialogActions>
  </Dialog>
  );
};

export default CloseAgentDialog;
