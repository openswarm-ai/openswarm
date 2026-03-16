import React, { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const shortcuts = [
  { key: 'd', description: 'Go to Dashboard' },
  { key: 't', description: 'Go to Templates' },
  { key: '1-9', description: 'Open agent by position' },
  { key: '⌘M', description: 'Add App' },
  { key: '⌘O', description: 'History' },
  { key: 'Shift+A', description: 'Approve all pending' },
  { key: 'Shift+D', description: 'Deny all pending' },
  { key: '?', description: 'Show this help' },
];

const KeyboardShortcutsHelp: React.FC = () => {
  const c = useClaudeTokens();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.key === '?') {
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      PaperProps={{
        sx: {
          bgcolor: c.bg.surface,
          color: c.text.primary,
          borderRadius: 4,
          border: `1px solid ${c.border.subtle}`,
          minWidth: 360,
          boxShadow: c.shadow.lg,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
        Keyboard Shortcuts
      </DialogTitle>
      <DialogContent>
        {shortcuts.map((s) => (
          <Box
            key={s.key}
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              py: 0.75,
              borderBottom: `0.5px solid ${c.border.medium}`,
              '&:last-child': { borderBottom: 'none' },
            }}
          >
            <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{s.description}</Typography>
            <Box
              sx={{
                bgcolor: c.bg.secondary,
                border: `1px solid ${c.border.medium}`,
                borderRadius: 1,
                px: 1,
                py: 0.25,
              }}
            >
              <Typography
                sx={{
                  color: c.accent.primary,
                  fontSize: '0.75rem',
                  fontFamily: c.font.mono,
                  fontWeight: 600,
                }}
              >
                {s.key}
              </Typography>
            </Box>
          </Box>
        ))}
      </DialogContent>
    </Dialog>
  );
};

export default KeyboardShortcutsHelp;
