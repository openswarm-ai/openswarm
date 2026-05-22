// Vertical step list with connector + optional live-fill during a run +
// optional auto-icon per step + optional duration estimate per step.
// Used by both the Preview (draft) view and the Saved view so the two
// stay visually consistent.

import React from 'react';
import Box from '@mui/material/Box';
import TextareaAutosize from '@mui/material/TextareaAutosize';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { Workflow, WorkflowRun } from '@/shared/state/workflowsSlice';
import { stepIconFor, estimateStepDuration } from './workflowVisuals';

interface Props {
  workflow?: Workflow | null;
  steps: Workflow['steps'];
  runs?: WorkflowRun[];
  // Pass the active run id to fill the connector progressively as the
  // workflow streams. Currently estimated by elapsed/expected; once
  // per-step telemetry ships, swap to a real step-index signal.
  activeRunId?: string | null;
  // Subtle frame around each step (used by Preview's edit-mode look). The
  // Saved view turns this off for a quieter read.
  framed?: boolean;
  // Callback when a step row is edited inline; only useful in Preview.
  onChangeStep?: (idx: number, text: string) => void;
  // Callback when the trash icon next to a step is clicked. Pairs with
  // onAddStep on the parent. Provide both when editing; omit for read-only.
  onDeleteStep?: (idx: number) => void;
  onAddStep?: () => void;
}

const CIRCLE_SIZE = 24;
// Vertical connector lives on the inner edge of the circle column; its
// x-offset matches CIRCLE_SIZE/2 so it bisects the numbered circles.
const CONNECTOR_X = CIRCLE_SIZE / 2;

export default function StepList({ workflow, steps, runs, activeRunId, framed, onChangeStep }: Props) {
  const c = useClaudeTokens();
  const hasSteps = steps && steps.length > 0;
  if (!hasSteps) return null;

  // Determine "current step" for live-fill. We don't have per-step
  // telemetry yet, so estimate via elapsed/expected ratio if a run is
  // active, otherwise leave it null (no fill).
  const activeStepIdx = useActiveStepIdx(steps.length, runs, activeRunId);

  return (
    <Box sx={{ position: 'relative', pl: 0, mt: 0.25 }}>
      {/* Connector spine. SVG so the live-fill segment can clip cleanly. */}
      {steps.length > 1 && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: CONNECTOR_X - 0.5,
            top: CIRCLE_SIZE * 0.5,
            bottom: CIRCLE_SIZE * 0.5,
            width: 1,
            bgcolor: c.border.medium,
            opacity: 0.65,
          }}
        />
      )}
      {steps.length > 1 && activeStepIdx !== null && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: CONNECTOR_X - 1,
            top: CIRCLE_SIZE * 0.5,
            // Progress = (active+1)/total, capped at total-1 so the fill
            // never overshoots the bottom circle.
            height: `calc((100% - ${CIRCLE_SIZE}px) * ${Math.min(steps.length - 1, activeStepIdx) / (steps.length - 1)})`,
            width: 2,
            bgcolor: c.accent.primary,
            transition: 'height 0.4s ease-out',
            boxShadow: `0 0 6px ${c.accent.primary}`,
          }}
        />
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.85 }}>
        {steps.map((s, idx) => {
          const Icon = stepIconFor(s.text || '');
          const duration = workflow ? estimateStepDuration(workflow, runs, idx) : null;
          const isActive = activeStepIdx === idx;
          const isPast = activeStepIdx !== null && idx < activeStepIdx;
          // Target #54: step 1 always gets the framed-box treatment so
          // the eye lands on it (it reads as the "entry point" of the
          // workflow), steps 2+ stay plain text. The disc fill follows
          // the live run: active step gets the solid accent disc; past
          // steps a tinted disc; the rest a quiet outlined circle. When
          // no run is in flight, nothing is "active" so all discs stay
          // outlined, including step 1.
          const firstStep = idx === 0;
          // All steps look identical when framed; the orange disc on
          // step 1 already does the "entry point" signaling. Singling
          // out step 1 made 2+ read as static text.
          const frameThis = framed;
          const primary = (framed && firstStep) || isActive;
          return (
            <Box key={s.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, position: 'relative' }}>
              <Box sx={{
                width: CIRCLE_SIZE, height: CIRCLE_SIZE, borderRadius: '50%',
                border: `1px solid ${primary || isPast ? c.accent.primary : c.border.medium}`,
                bgcolor: primary ? c.accent.primary : isPast ? c.accent.primary + '22' : c.bg.surface,
                color: primary ? '#fff' : isPast ? c.accent.primary : c.text.muted,
                fontSize: '0.74rem', fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                position: 'relative', zIndex: 1,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                transition: 'background 0.25s ease, color 0.25s ease',
              }}>
                {Icon ? <Icon sx={{ fontSize: 13 }} /> : (idx + 1)}
              </Box>
              <Box
                sx={{
                  flex: 1,
                  minWidth: 0,
                  // Hover + focus give 2+ steps a visible edge so the user
                  // discovers they're editable. Step 1 already shows a
                  // permanent frame; this just makes the rest discoverable.
                  '& textarea:hover': {
                    borderColor: `${c.border.medium} !important`,
                    background: `${c.bg.surface} !important`,
                  },
                  '& textarea:focus': {
                    borderColor: `${c.accent.primary} !important`,
                    background: `${c.bg.surface} !important`,
                  },
                }}>
                {onChangeStep ? (
                  <TextareaAutosize
                    value={s.text}
                    onChange={(e) => onChangeStep(idx, e.target.value)}
                    minRows={1}
                    style={{
                      width: '100%',
                      resize: 'none',
                      boxSizing: 'border-box',
                      fontFamily: 'inherit',
                      fontSize: '0.92rem',
                      color: c.text.primary,
                      border: frameThis ? `1px solid ${c.border.medium}` : '1px solid transparent',
                      borderRadius: `${c.radius.md}px`,
                      background: frameThis ? c.bg.surface : 'transparent',
                      padding: '6px 10px',
                      lineHeight: 1.45,
                      outline: 'none',
                      overflow: 'hidden',
                      transition: 'border-color 0.12s ease, background 0.12s ease',
                    }}
                  />
                ) : (
                  <Box sx={{
                    fontSize: '0.92rem', color: c.text.primary,
                    border: frameThis ? `1px solid ${c.border.medium}` : 'none',
                    borderRadius: frameThis ? `${c.radius.md}px` : 0,
                    bgcolor: frameThis ? c.bg.surface : 'transparent',
                    px: frameThis ? 1.25 : 0, py: frameThis ? 0.75 : 0.1,
                    lineHeight: 1.45,
                  }}>
                    {s.text}
                  </Box>
                )}
                {duration && (
                  <Tooltip title="Estimated from recent successful runs (whole-run duration divided by step count).">
                    <Typography sx={{ fontSize: '0.7rem', color: c.text.ghost, mt: 0.25, ml: framed ? 1.25 : 0.5 }}>
                      ~{duration}
                    </Typography>
                  </Tooltip>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// Synthesize an "active step" index from the active run's elapsed time
// vs the historical average run duration. Doesn't pretend to be exact;
// good enough for the user to see the progress bar advance during a
// long workflow. Returns null when no live run.
function useActiveStepIdx(stepCount: number, runs: WorkflowRun[] | undefined, activeRunId: string | null | undefined): number | null {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!activeRunId) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 1000000), 1000);
    return () => window.clearInterval(id);
  }, [activeRunId]);
  void tick;
  if (!activeRunId || !runs) return null;
  const active = runs.find((r) => r.id === activeRunId && r.status === 'running');
  if (!active) return null;
  const elapsed = Date.now() - new Date(active.started_at).getTime();
  const completed = runs.filter((r) => (r.status === 'success' || r.status === 'ran_late') && r.finished_at);
  if (completed.length === 0) {
    // No history: jump to the middle step so the bar advances visibly.
    return Math.min(stepCount - 1, Math.max(0, Math.floor(stepCount / 2)));
  }
  const durations = completed.slice(0, 10).map((r) => new Date(r.finished_at!).getTime() - new Date(r.started_at).getTime());
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length || 1;
  const ratio = Math.min(0.99, Math.max(0, elapsed / avg));
  return Math.min(stepCount - 1, Math.floor(ratio * stepCount));
}
