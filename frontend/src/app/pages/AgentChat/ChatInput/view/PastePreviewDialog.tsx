import React, { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getPasteContent } from '@/app/components/editor/richEditorUtils';

interface Props {
  pasteId: string | null;
  onClose: () => void;
  onSave: (pasteId: string, text: string) => void;
}

export const PastePreviewDialog: React.FC<Props> = ({ pasteId, onClose, onSave }) => {
  const c = useClaudeTokens();
  const open = !!pasteId;
  const original = pasteId ? getPasteContent(pasteId) : undefined;
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft(original ?? '');
  }, [pasteId]);

  const handleChange = (text: string) => {
    setDraft(text);
    if (pasteId) onSave(pasteId, text);
  };

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
          {draft.length.toLocaleString()} characters
        </Typography>
      </Box>
      <Box sx={{ p: 2, bgcolor: c.bg.surface }}>
        {original === undefined ? (
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.85rem', fontStyle: 'italic' }}>
            This pasted text is no longer available. Re-paste to restore it.
          </Typography>
        ) : (
          <TextField
            value={draft}
            onChange={(e) => handleChange(e.target.value)}
            multiline
            fullWidth
            minRows={6}
            maxRows={20}
            autoFocus
            sx={{
              '& .MuiInputBase-root': {
                fontFamily: c.font.mono,
                fontSize: '0.78rem',
                color: c.text.primary,
                alignItems: 'flex-start',
              },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: c.border.subtle },
            }}
          />
        )}
      </Box>
    </Dialog>
  );
};
