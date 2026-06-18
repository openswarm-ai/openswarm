// The two popovers in the Edit Agent Save flow (Image #50): on Save we ask
// "test before finishing?"; once a test ends we ask "Confirm save". Both are
// presentational and reuse the ScheduleThisPopover Popover styling so the
// modify flow feels of a piece with scheduling.

import React from 'react';
import Popover from '@mui/material/Popover';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface OptionProps {
  label: string;
  hint: string;
  onClick: () => void;
  accent?: boolean;
  danger?: boolean;
}

function OptionRow({ label, hint, onClick, accent, danger }: OptionProps) {
  const c = useClaudeTokens();
  const labelColor = danger ? c.status.error : accent ? c.accent.primary : c.text.primary;
  return (
    <Box
      role="button"
      onClick={onClick}
      sx={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        px: 1, py: 0.7, borderRadius: `${c.radius.md}px`, cursor: 'pointer',
        '&:hover': { bgcolor: c.bg.elevated },
      }}>
      <Typography sx={{ fontSize: '0.86rem', fontWeight: 600, color: labelColor }}>{label}</Typography>
      <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>{hint}</Typography>
    </Box>
  );
}

// 'testing' is a live state with no popover (the Test Agent card owns the
// post-test decision); the popover only shows for 'ask-test' and 'confirm-discard'.
export type SavePhase = 'idle' | 'ask-test' | 'testing' | 'confirm-discard';

interface Props {
  phase: SavePhase;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onSaveNow: () => void;
  onRunTest: () => void;
  onConfirmDiscard: () => void;
}

export default function EditAgentSavePopovers({
  phase, anchorEl, onClose, onSaveNow, onRunTest, onConfirmDiscard,
}: Props) {
  const c = useClaudeTokens();
  const heading = (text: string) => (
    <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', mb: 0.75 }}>
      {text}
    </Typography>
  );
  return (
    <Popover
      open={phase === 'ask-test' || phase === 'confirm-discard'}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 300, p: 1.25 } } }}
    >
      {phase === 'ask-test' && (
        <>
          {heading('BEFORE YOU SAVE')}
          <Typography sx={{ fontSize: '0.84rem', color: c.text.secondary, mb: 0.75, lineHeight: 1.4 }}>
            Want to test the workflow before finishing your edits?
          </Typography>
          <OptionRow label="Yes, test it" hint="Run the draft once so you can watch it work" onClick={onRunTest} accent />
          <OptionRow label="No, save now" hint="Commit your edits without a test run" onClick={onSaveNow} />
        </>
      )}
      {phase === 'confirm-discard' && (
        <>
          {heading('DISCARD CHANGES')}
          <Typography sx={{ fontSize: '0.84rem', color: c.text.secondary, mb: 0.75, lineHeight: 1.4 }}>
            Throw away every edit from this session? This can&apos;t be undone.
          </Typography>
          <OptionRow label="Discard changes" hint="Revert to the saved workflow" onClick={onConfirmDiscard} danger />
          <OptionRow label="Keep editing" hint="Stay on the editing window" onClick={onClose} />
        </>
      )}
    </Popover>
  );
}
