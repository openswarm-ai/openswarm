import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getPasteContent } from '@/app/components/editor/richEditorUtils';

interface Props {
  pasteId: string | null;
  onClose: () => void;
  onSave: (pasteId: string, text: string) => void;
}

// Uncontrolled on purpose: huge pastes are this dialog's whole job, and a controlled MUI autosize field re-reconciles the full string + re-measures a shadow textarea per keystroke (typing molasses at ~300KB).
const PasteEditor: React.FC<{ pasteId: string; initial: string; onSave: Props['onSave']; onCount: (n: number) => void }> = ({ pasteId, initial, onSave, onCount }) => {
  const c = useClaudeTokens();
  return (
    <textarea
      defaultValue={initial}
      autoFocus
      onChange={(e) => { onSave(pasteId, e.target.value); onCount(e.target.value.length); }}
      style={{
        width: '100%',
        minHeight: '9rem',
        maxHeight: '55vh',
        height: '40vh',
        resize: 'vertical',
        overflowY: 'auto',
        fontFamily: c.font.mono,
        fontSize: '0.78rem',
        lineHeight: 1.5,
        color: c.text.primary,
        background: 'transparent',
        border: `1px solid ${c.border.subtle}`,
        borderRadius: 8,
        padding: '10px 12px',
        outline: 'none',
        boxSizing: 'border-box',
      }}
    />
  );
};

export const PastePreviewDialog: React.FC<Props> = ({ pasteId, onClose, onSave }) => {
  const c = useClaudeTokens();
  const open = !!pasteId;
  const original = pasteId ? getPasteContent(pasteId) : undefined;
  // Keyed by paste id so an id swap can never show the previous paste's count.
  const [charCount, setCharCount] = useState<{ id: string; n: number } | null>(null);
  const liveCount = charCount && charCount.id === pasteId ? charCount.n : null;

  return (
    <Dialog
      open={open}
      onClose={() => { setCharCount(null); onClose(); }}
      PaperProps={{ sx: { bgcolor: c.bg.elevated, borderRadius: 3, p: 0, minWidth: 520, maxWidth: 760, width: '70vw' } }}
    >
      <Box sx={{ p: 2, borderBottom: `1px solid ${c.border.subtle}` }}>
        <Typography sx={{ color: c.text.primary, fontSize: '1rem', fontWeight: 600 }}>
          Pasted text
        </Typography>
        <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem', mt: 0.25 }}>
          {(liveCount ?? original?.length ?? 0).toLocaleString()} characters
        </Typography>
      </Box>
      <Box sx={{ p: 2, bgcolor: c.bg.surface }}>
        {original === undefined || pasteId === null ? (
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.85rem', fontStyle: 'italic' }}>
            This pasted text is no longer available. Re-paste to restore it.
          </Typography>
        ) : (
          // key remounts the editor per paste id, so a reopened dialog always seeds from the current stored content (no stale-draft sync effect to get wrong).
          <PasteEditor key={pasteId} pasteId={pasteId} initial={original} onSave={onSave} onCount={(n) => setCharCount({ id: pasteId, n })} />
        )}
      </Box>
    </Dialog>
  );
};
