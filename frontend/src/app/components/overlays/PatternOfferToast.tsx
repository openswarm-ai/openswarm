// Bottom-left nudge for a mined behavior pattern: "you do this a lot, want a workflow?".
// Cites real evidence (count + rhythm) because users know they waste time on SOMETHING
// but usually can't name it. Create makes a real workflow and opens it for review;
// "No thanks" dismisses the pattern permanently; the X just hides it for now.

import React from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  PatternSuggestion,
  acceptPatternSuggestion,
  dismissPatternSuggestion,
  hidePatternToast,
} from '@/shared/state/patternsSlice';
import { openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import { useNudgeTurn } from '@/app/components/overlays/nudgeQueue';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatHour(hour: number): string {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

function evidenceLine(s: PatternSuggestion): string {
  const base = `Noticed ${s.evidence_count} times this month`;
  if (s.cadence.kind === 'weekly' && s.cadence.on_days.length > 0) {
    return `${base}, usually ${DAY_NAMES[s.cadence.on_days[0]]}s around ${formatHour(s.cadence.hour)}.`;
  }
  if (s.cadence.kind === 'daily') {
    return `${base}, most days around ${formatHour(s.cadence.hour)}.`;
  }
  return `${base}.`;
}

export default function PatternOfferToast() {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.patterns.toastOpen);
  const accepting = useAppSelector((s) => s.patterns.accepting);
  const suggestion = useAppSelector((s) => s.patterns.suggestions[0]);
  const myTurn = useNudgeTurn('patterns');

  const onCreate = React.useCallback(async () => {
    if (!suggestion) return;
    try {
      const res = await dispatch(acceptPatternSuggestion(suggestion.id)).unwrap();
      dispatch(openWorkflowsApp({ workflowId: res.workflow.id }));
    } catch {
      // Accept failed server-side; leave the toast up so the user can retry.
    }
  }, [dispatch, suggestion]);

  const onDecline = React.useCallback(() => {
    if (suggestion) dispatch(dismissPatternSuggestion(suggestion.id));
  }, [dispatch, suggestion]);

  return (
    <Snackbar
      open={open && !!suggestion && myTurn}
      autoHideDuration={null}
      // Clickaway would kill the offer on the user's first canvas click, before they read it.
      onClose={(event, reason) => { if (reason !== 'clickaway') dispatch(hidePatternToast()); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        icon={false}
        severity="info"
        sx={{
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          maxWidth: 460,
          '& .MuiAlert-action': { alignItems: 'center', pt: 0 },
        }}
        action={
          <>
            <Button size="small" disabled={accepting} onClick={onCreate} sx={{ color: c.accent.primary, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {accepting ? 'Creating...' : 'Create workflow'}
            </Button>
            <Button size="small" disabled={accepting} onClick={onDecline} sx={{ color: c.text.muted, whiteSpace: 'nowrap' }}>
              No thanks
            </Button>
            <IconButton
              size="small"
              aria-label="Hide for now"
              onClick={() => dispatch(hidePatternToast())}
              sx={{ color: c.text.muted, ml: 0.25, '&:hover': { color: c.text.primary } }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </>
        }
      >
        {suggestion ? `${suggestion.description} ${evidenceLine(suggestion)} Want me to make it a workflow that runs itself?` : ''}
      </Alert>
    </Snackbar>
  );
}
