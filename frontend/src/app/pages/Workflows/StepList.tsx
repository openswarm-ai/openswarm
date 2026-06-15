// Vertical step list, the one shared building block across every
// workflow card subview. Supports three orthogonal modes that compose:
//
//   editable    onChangeStep is set -> each row is a TextareaAutosize
//                                       (PreviewView only).
//   expandable  expandable=true     -> chevron next to each title;
//                                       click reveals the raw prompt body.
//   live        stepStatuses is set -> per-step circle becomes done/active/
//                                       failed; Running view also surfaces
//                                       activeStepSubtitle + duration.

import React from 'react';
import Box from '@mui/material/Box';
import TextareaAutosize from '@mui/material/TextareaAutosize';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { Workflow, WorkflowRun } from '@/shared/state/workflowsSlice';

export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

interface Props {
  workflow?: Workflow | null;
  steps: Workflow['steps'];
  runs?: WorkflowRun[];
  activeRunId?: string | null;
  framed?: boolean;
  // Edit mode
  onChangeStep?: (idx: number, text: string) => void;
  // Expand mode
  expandable?: boolean;
  expandedIds?: string[];
  onToggleExpand?: (id: string) => void;
  // Live mode
  stepStatuses?: StepStatus[];
  activeStepSubtitle?: string | null;
  activeStepDuration?: string | null;
  // Cap visible rows; render "... N more" beneath when truncated.
  maxVisible?: number;
}

const CIRCLE_SIZE = 24;
const CONNECTOR_X = CIRCLE_SIZE / 2;

export default function StepList(props: Props) {
  const {
    steps, framed, onChangeStep,
    expandable, expandedIds, onToggleExpand,
    stepStatuses, activeStepSubtitle, activeStepDuration,
    maxVisible = 4,
  } = props;
  const c = useClaudeTokens();
  if (!steps || steps.length === 0) return null;

  const visible = steps.slice(0, maxVisible);
  const hiddenCount = Math.max(0, steps.length - visible.length);
  const expanded = new Set(expandedIds || []);

  return (
    <Box sx={{ position: 'relative', pl: 0, mt: 0.25 }}>
      {visible.length > 1 && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: CONNECTOR_X - 0.5,
            top: CIRCLE_SIZE * 0.5,
            bottom: CIRCLE_SIZE * 0.5,
            // '1px' not 1: MUI sx treats width:1 as 100%, which rendered the
            // connector as a full-width grey band behind the steps.
            width: '1px',
            bgcolor: c.border.medium,
            opacity: 0.65,
          }}
        />
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.85 }}>
        {visible.map((s, idx) => {
          const status: StepStatus = stepStatuses?.[idx] ?? 'pending';
          const isActive = status === 'active';
          const isDone = status === 'done';
          const isFailed = status === 'failed';
          const isExpanded = expanded.has(s.id);
          const label = (s.label || '').trim() || firstWords(s.text, 6);
          const rawBody = (s.text || '').trim();
          const hasExpandableBody = expandable && rawBody && rawBody !== label;

          return (
            <Box key={s.id} sx={{ display: 'flex', flexDirection: 'column' }}>
              <Box
                onClick={hasExpandableBody && !isActive ? () => onToggleExpand?.(s.id) : undefined}
                sx={{
                  display: 'flex', alignItems: 'flex-start', gap: 1.25,
                  position: 'relative',
                  cursor: hasExpandableBody && !isActive ? 'pointer' : 'default',
                  borderRadius: `${c.radius.md}px`,
                  px: (isActive || (isExpanded && hasExpandableBody)) ? 0.5 : 0,
                  py: (isActive || (isExpanded && hasExpandableBody)) ? 0.5 : 0,
                  mx: (isActive || (isExpanded && hasExpandableBody)) ? -0.5 : 0,
                  bgcolor: (isActive || (isExpanded && hasExpandableBody)) ? c.bg.elevated : 'transparent',
                  transition: 'background 0.18s ease',
                  '&:hover': hasExpandableBody && !isActive ? { bgcolor: c.bg.elevated } : {},
                }}>
                <StepDisc
                  index={idx}
                  status={status}
                  framed={!!framed}
                  c={c}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
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
                        border: framed ? `1px solid ${c.border.medium}` : '1px solid transparent',
                        borderRadius: `${c.radius.md}px`,
                        background: framed ? c.bg.surface : 'transparent',
                        padding: '6px 10px',
                        lineHeight: 1.45,
                        outline: 'none',
                        overflow: 'hidden',
                        transition: 'border-color 0.12s ease, background 0.12s ease',
                      }}
                    />
                  ) : (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: CIRCLE_SIZE }}>
                      <Typography sx={{
                        fontSize: '0.92rem',
                        fontWeight: isActive ? 600 : 500,
                        color: c.text.primary,
                        lineHeight: 1.45,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {label}
                      </Typography>
                      {isActive && activeStepDuration && (
                        <Typography sx={{ fontSize: '0.78rem', color: c.text.muted, mr: hasExpandableBody ? 0 : 0.5, flexShrink: 0 }}>
                          {activeStepDuration}
                        </Typography>
                      )}
                      {hasExpandableBody && !isActive && (
                        <KeyboardArrowDownRounded sx={{
                          fontSize: 18,
                          color: c.text.muted,
                          transform: isExpanded ? 'rotate(180deg)' : 'none',
                          transition: 'transform 0.18s ease',
                          flexShrink: 0,
                        }} />
                      )}
                    </Box>
                  )}
                  {/* Active step: tool call subtitle. Sits under the title
                      with a small leading glyph so the user can read it as
                      "what the agent is doing right now". */}
                  {isActive && activeStepSubtitle && (
                    <Typography sx={{
                      fontSize: '0.82rem',
                      color: c.text.secondary,
                      mt: 0.4,
                      display: 'flex', alignItems: 'center', gap: 0.5,
                    }}>
                      <Box component="span" sx={{ display: 'inline-flex', fontSize: 13 }}>{'▢'}</Box>
                      {activeStepSubtitle}
                    </Typography>
                  )}
                  {/* Expanded body: the raw prompt that lives under the
                      LLM label. Soft elevated panel so it reads as a
                      drill-down, not a separate step. */}
                  {hasExpandableBody && isExpanded && (
                    <Box sx={{
                      mt: 0.6,
                      p: 1,
                      borderRadius: `${c.radius.md}px`,
                      bgcolor: c.bg.elevated,
                      border: `1px solid ${c.border.subtle}`,
                    }}>
                      <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                        {rawBody}
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>
              {isFailed && undefined}
              {isDone && undefined}
            </Box>
          );
        })}
      </Box>
      {hiddenCount > 0 && (
        <Typography sx={{
          fontSize: '0.86rem',
          color: c.text.secondary,
          mt: 0.6,
          ml: 0,
        }}>
          ... {hiddenCount} more
        </Typography>
      )}
    </Box>
  );
}

function StepDisc({ index, status, framed, c }: { index: number; status: StepStatus; framed: boolean; c: ReturnType<typeof useClaudeTokens> }) {
  if (status === 'done') {
    return (
      <Box sx={{
        width: CIRCLE_SIZE, height: CIRCLE_SIZE, borderRadius: '50%',
        bgcolor: c.text.muted + '55',
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, position: 'relative', zIndex: 1,
      }}>
        <CheckRounded sx={{ fontSize: 15 }} />
      </Box>
    );
  }
  if (status === 'failed') {
    return (
      <Box sx={{
        width: CIRCLE_SIZE, height: CIRCLE_SIZE, borderRadius: '50%',
        bgcolor: c.status.error,
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, position: 'relative', zIndex: 1,
        boxShadow: `0 0 0 3px ${c.status.error}22`,
      }}>
        <CloseRounded sx={{ fontSize: 15 }} />
      </Box>
    );
  }
  if (status === 'active') {
    return (
      <Box sx={{
        width: CIRCLE_SIZE, height: CIRCLE_SIZE, borderRadius: '50%',
        border: `2px solid ${c.accent.primary}`,
        bgcolor: c.bg.surface,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, position: 'relative', zIndex: 1,
        animation: 'workflow-step-spin 1.4s linear infinite',
        '@keyframes workflow-step-spin': {
          '0%':   { boxShadow: `0 0 0 0 ${c.accent.primary}55` },
          '50%':  { boxShadow: `0 0 0 4px ${c.accent.primary}00` },
          '100%': { boxShadow: `0 0 0 0 ${c.accent.primary}55` },
        },
      }}>
        <Box sx={{
          width: 8, height: 8, borderRadius: '50%',
          border: `1.5px solid ${c.accent.primary}`,
          borderTopColor: 'transparent',
          animation: 'workflow-step-dot 0.9s linear infinite',
          '@keyframes workflow-step-dot': {
            '0%':   { transform: 'rotate(0deg)' },
            '100%': { transform: 'rotate(360deg)' },
          },
        }} />
      </Box>
    );
  }
  // pending
  void framed;
  void index;
  return (
    <Box sx={{
      width: CIRCLE_SIZE, height: CIRCLE_SIZE, borderRadius: '50%',
      border: `1px solid ${c.border.medium}`,
      bgcolor: c.bg.surface,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, position: 'relative', zIndex: 1,
    }} />
  );
}

function firstWords(s: string, n: number): string {
  const words = (s || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return words.slice(0, n).join(' ') + '...';
}
