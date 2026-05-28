import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import DialogActions from '@mui/material/DialogActions';
import SaveIcon from '@mui/icons-material/Save';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const SettingsFooter: React.FC<{
  hasChanges: boolean;
  onDiscard: () => void;
  onClose: () => void;
  onSave: () => void;
}> = ({ hasChanges, onDiscard, onClose, onSave }) => {
  const c = useClaudeTokens();
  return (
    <DialogActions sx={{ borderTop: `1px solid ${c.border.subtle}`, px: 3, py: 1.5, justifyContent: 'space-between' }}>
      {/* Left: explicit Discard; only path to wipe the persisted draft. */}
      <Box>
        {hasChanges && (
          <Button
            onClick={onDiscard}
            sx={{ color: c.status.error, textTransform: 'none', fontSize: '0.85rem' }}
          >
            Discard changes
          </Button>
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          onClick={onClose}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Close
        </Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon sx={{ fontSize: 16 }} />}
          onClick={onSave}
          disabled={!hasChanges}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
            textTransform: 'none',
            borderRadius: 1.5,
            px: 2.5,
            fontSize: '0.85rem',
          }}
        >
          Save
        </Button>
      </Box>
    </DialogActions>
  );
};

export default SettingsFooter;
