// Footer for an agent card that's a workflow sidecar (Test Agent, or a watched run). It replaces the normal composer: while the agent runs you can't meaningfully chat, but you often want to kill it. Once a Test Agent finishes, the red "Force Stop" becomes the decision point: keep editing the workflow, or save the edits (which commits the draft and closes this card).

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  onStop: () => void;
  onSaveWorkflow: () => void;
  onContinueEditing: () => void;
  // 'running' while a test drives the steps; 'complete'/'error' when done. null for a watched (non-test) run, which only ever offers Force Stop.
  testState?: 'running' | 'complete' | 'error' | null;
}

export default function ForceStopAgentBar({ onStop, onSaveWorkflow, onContinueEditing, testState }: Props) {
  const c = useClaudeTokens();
  const done = testState === 'complete' || testState === 'error';

  if (!done) {
    return (
      <Box sx={{ px: 2, py: 1.5 }}>
        <Box
          role="button"
          onClick={onStop}
          sx={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.6,
            width: '100%', py: 0.9, borderRadius: 999, cursor: 'pointer',
            fontSize: '0.875rem', fontWeight: 700,
            color: c.status.error, bgcolor: c.status.error + '14', border: `1px solid ${c.status.error}55`,
            '&:hover': { bgcolor: c.status.error + '22' },
          }}>
          <StopCircleOutlined sx={{ fontSize: 17 }} />
          Force Stop Agent
        </Box>
      </Box>
    );
  }

  const tone = testState === 'complete' ? c.status.success : c.status.error;
  return (
    <Box sx={{ px: 2, py: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: tone, fontSize: '0.8125rem', fontWeight: 600 }}>
        <CheckCircleOutlineRounded sx={{ fontSize: 16 }} />
        {testState === 'complete' ? 'Test finished' : 'Test stopped'}
      </Box>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Box
          role="button"
          onClick={onContinueEditing}
          sx={{
            flex: 1, textAlign: 'center', py: 0.8, borderRadius: 999, cursor: 'pointer',
            fontSize: '0.8125rem', fontWeight: 600, color: c.text.secondary,
            border: `1px solid ${c.border.medium}`,
            '&:hover': { bgcolor: c.bg.elevated, color: c.text.primary },
          }}>
          Continue editing
        </Box>
        <Box
          role="button"
          onClick={onSaveWorkflow}
          sx={{
            flex: 1, textAlign: 'center', py: 0.8, borderRadius: 999, cursor: 'pointer',
            fontSize: '0.8125rem', fontWeight: 700, color: '#fff', bgcolor: c.accent.primary,
            '&:hover': { filter: 'brightness(1.05)' },
          }}>
          Save workflow
        </Box>
      </Box>
    </Box>
  );
}
