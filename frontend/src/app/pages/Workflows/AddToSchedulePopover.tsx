import React, { useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import { addWorkflowCard } from '@/shared/state/dashboardLayoutSlice';
import { openWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
import { needsScheduleTestWarning } from './scheduleUtils';

interface Props {
  anchorEl: HTMLElement | null;
  workflow: Workflow | null;
  onClose: () => void;
}

// Opens off an Unscheduled workflow's "+" icon. These workflows have no
// real cadence yet, so the only safe action is to create one.
export default function AddToSchedulePopover({ anchorEl, workflow, onClose }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();

  const makeSchedule = useCallback(() => {
    if (!workflow) return;
    dispatch(addWorkflowCard({ workflowId: workflow.id }));
    // Untested steps: land on the saved card so its Schedule button can warn and
    // offer a test run (which needs the card's sidecar context). Otherwise go
    // straight to scheduling.
    const view = needsScheduleTestWarning(workflow) ? 'saved' : 'scheduling';
    dispatch(openWorkflowCard({ workflowId: workflow.id, view }));
    onClose();
  }, [dispatch, workflow, onClose]);

  const rowSx = {
    display: 'flex', alignItems: 'center', gap: 0.9,
    px: 0.75, py: 0.65, borderRadius: `${c.radius.md}px`, cursor: 'pointer',
    '&:hover': { bgcolor: c.bg.elevated },
  };
  const iconSx = {
    width: 28, height: 28, borderRadius: `${c.radius.md}px`, flexShrink: 0,
    bgcolor: c.accent.primary + '18', color: c.accent.primary,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <Popover
      open={Boolean(anchorEl && workflow)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
      transformOrigin={{ vertical: 'center', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 272, p: 1, ml: 0.75 } } }}
    >
      <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: c.text.muted, letterSpacing: '0.06em', px: 0.75, mb: 0.5 }}>
        NEEDS SCHEDULE
      </Typography>
      <Box role="button" onClick={makeSchedule} sx={rowSx}>
        <Box sx={iconSx}><CalendarMonthRounded sx={{ fontSize: 16 }} /></Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.84rem', fontWeight: 600, color: c.text.primary }}>Make a schedule</Typography>
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>This workflow does not have a schedule yet. Choose when it should run.</Typography>
        </Box>
      </Box>
    </Popover>
  );
}
