import React from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getPasteContent } from '@/app/components/editor/richEditorUtils';

interface Props {
  pasteId: string | null;
  onClose: () => void;
}

export const PastePreviewDialog: React.FC<Props> = ({ pasteId, onClose }) => {
  const c = useClaudeTokens();
  const open = !!pasteId;
  const content = pasteId ? (getPasteContent(pasteId) ?? '') : '';
  const chars = content.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { bgcolor: c.bg.elevated, borderRadius: 3, p: 0, minWidth: 520, maxWidth: 760, width: '70vw' } }}
    >
      <Box sx={{ p: 2, borderBottom: `1px solid ${c.border.subtle}` }}>
        <Typography sx={{ color: c.text.primary, fontSize: '1rem', fontWeight: 600 }}>
          Pasted text
        </Typography>
        <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem', mt: 0.25 }}>
          {chars.toLocaleString()} characters
        </Typography>
      </Box>
      <Box
        sx={{
          p: 2,
          maxHeight: '60vh',
          overflowY: 'auto',
          fontFamily: c.font.mono,
          fontSize: '0.78rem',
          color: c.text.primary,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          bgcolor: c.bg.surface,
        }}
      >
        {content || (
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.85rem', fontStyle: 'italic' }}>
            This pasted text is no longer available. Re-paste to restore it.
          </Typography>
        )}
      </Box>
    </Dialog>
  );
};
