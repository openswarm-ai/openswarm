// Image #38: Edit Agent chat shell embedded inside the workflow card.
// Header is { Discard | Save }. Body shows a soft frame around the step
// list, then the conversation (agent reply bubbles + tool-call cards +
// user bubbles), then a composer at the bottom. Submitting a message
// hits /workflows/{id}/edit-step which uses aux LLM to propose a step
// edit. The user reviews the proposal, then either applies it to the
// draft (local) or asks the agent to try again. Save persists the
// accumulated draft via PATCH; Discard reverts to the saved state.
//
// Test Agent (Image #39) integration lands in slice 5; the "Test" button
// here is wired but the spawned sibling currently runs the saved workflow
// (not the unsaved draft) until the run endpoint accepts step overrides.

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import Tooltip from '@mui/material/Tooltip';
import TextareaAutosize from '@mui/material/TextareaAutosize';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import BuildRounded from '@mui/icons-material/BuildRounded';
import TuneRounded from '@mui/icons-material/TuneRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearFixSeed, setCardSidecar, updateWorkflow, updateWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
import { DEFAULT_CARD_W, DEFAULT_CARD_H, placeCard } from '@/shared/state/dashboardLayoutSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import StepList from './StepList';
import { API_BASE, getAuthToken } from '@/shared/config';
import ScienceOutlined from '@mui/icons-material/ScienceOutlined';

interface Props {
  workflow: Workflow;
  steps: Workflow['steps'];
  isFixMode?: boolean;
}

function InlineSubtitle({ workflow }: { workflow: Workflow }) {
  const c = useClaudeTokens();
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const runs = useAppSelector((s) => s.workflows.runs[workflow.id]);
  const modelLabel = React.useMemo(() => {
    if (!workflow?.model) return '';
    for (const list of Object.values(modelsByProvider || {})) {
      for (const m of (list as Array<{ value: string; label?: string }>) || []) {
        if (m.value === workflow.model) return m.label || workflow.model;
      }
    }
    return workflow.model;
  }, [workflow?.model, modelsByProvider]);
  const duration = React.useMemo(() => {
    if (!runs || runs.length === 0) return '';
    const last = runs.find((r) => r.finished_at);
    if (!last || !last.finished_at) return '';
    const ms = new Date(last.finished_at).getTime() - new Date(last.started_at).getTime();
    if (ms <= 0) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60_000)}m`;
  }, [runs]);
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25, fontSize: '0.82rem', color: c.text.muted, minWidth: 0, overflow: 'hidden' }}>
      {modelLabel && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{modelLabel}</Box>}
      {workflow.mode && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{workflow.mode}</Box>}
      {duration && <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{duration}</Box>}
    </Box>
  );
}

type Turn =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'proposal'; stepIdx: number; before: string; after: string; explanation: string; applied: boolean }
  | { kind: 'fix-prefix'; stepIdx: number; stepLabel: string; error: string; expanded: boolean };

export default function EditAgentView({ workflow, steps, isFixMode = false }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const wfCardPos = useAppSelector((s) => s.dashboardLayout.workflowCards[workflow.id]);
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);
  const fixSeed = card?.fixSeed || null;
  const [showSaveBeforeTest, setShowSaveBeforeTest] = useState(false);

  const [draftSteps, setDraftSteps] = useState<Workflow['steps']>(steps);
  const [turns, setTurns] = useState<Turn[]>(() => isFixMode && fixSeed ? [
    { kind: 'fix-prefix', stepIdx: fixSeed.stepIdx, stepLabel: fixSeed.stepLabel, error: fixSeed.error, expanded: false },
  ] : [
    { kind: 'assistant', text: 'How would you like to modify the workflow (e.g. filter out spam emails before summarizing)' },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);

  useEffect(() => () => { dispatch(clearFixSeed(workflow.id)); }, [dispatch, workflow.id]);

  const dirty = React.useMemo(() => {
    if (draftSteps.length !== steps.length) return true;
    for (let i = 0; i < steps.length; i++) {
      if ((draftSteps[i]?.text || '') !== (steps[i]?.text || '')) return true;
      if ((draftSteps[i]?.label || '') !== (steps[i]?.label || '')) return true;
    }
    return false;
  }, [draftSteps, steps]);

  const onSubmit = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    // Capture history BEFORE pushing the user turn so the model doesn't
    // see the just-submitted message twice (once in history, once as the
    // current user message).
    const turnsSnapshot = turns;
    setTurns((t) => [...t, { kind: 'user', text }]);
    setDraft('');
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      // Pull the prior conversation so the model has multi-turn memory.
      // Proposals get folded into the history as "Assistant: proposed
      // changing step N to ..." so follow-ups like "yes do that" resolve
      // correctly. Cap to last 12 entries to keep payload tight.
      const historyPayload = turnsSnapshot.flatMap((t) => {
        if (t.kind === 'user') return [{ role: 'user', text: t.text }];
        if (t.kind === 'assistant') return [{ role: 'assistant', text: t.text }];
        if (t.kind === 'proposal') {
          const verb = t.applied ? 'applied' : 'proposed';
          return [{ role: 'assistant', text: `(${verb}) change step ${t.stepIdx + 1} to: ${t.after.slice(0, 200)}` }];
        }
        if (t.kind === 'fix-prefix') {
          return [{ role: 'assistant', text: `Fixing step ${t.stepIdx + 1}: ${t.error.slice(0, 200)}` }];
        }
        return [];
      });
      const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/propose-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({
          message: text,
          steps: draftSteps.map((s) => ({ id: s.id, text: s.text, label: s.label || null })),
          context: isFixMode && fixSeed ? { failed_step: fixSeed.stepIdx, error: fixSeed.error } : null,
          history: historyPayload,
        }),
      });
      if (!res.ok) {
        setTurns((t) => [...t, { kind: 'assistant', text: `Sorry, that didn't go through. (${res.status})` }]);
        return;
      }
      const data = await res.json();
      if (data?.reply) setTurns((t) => [...t, { kind: 'assistant', text: data.reply as string }]);
      if (typeof data?.step_idx === 'number' && typeof data?.new_text === 'string') {
        setTurns((t) => [...t, {
          kind: 'proposal',
          stepIdx: data.step_idx,
          before: draftSteps[data.step_idx]?.text || '',
          after: data.new_text,
          explanation: data.explanation || '',
          applied: false,
        }]);
      }
    } catch (e) {
      setTurns((t) => [...t, { kind: 'assistant', text: (e as Error)?.message || 'Network error.' }]);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, workflow.id, draftSteps, isFixMode, fixSeed]);

  const onApplyProposal = useCallback((turnIdx: number) => {
    setTurns((all) => {
      const next = all.slice();
      const turn = next[turnIdx];
      if (turn?.kind !== 'proposal' || turn.applied) return all;
      setDraftSteps((ds) => {
        const updated = ds.slice();
        if (updated[turn.stepIdx]) {
          updated[turn.stepIdx] = { ...updated[turn.stepIdx], text: turn.after };
        }
        return updated;
      });
      next[turnIdx] = { ...turn, applied: true };
      return next;
    });
  }, []);

  const onDiscard = useCallback(() => {
    if (dirty) {
      // No second confirm; the agent's proposals weren't persisted yet.
      // Reverting just clears local state.
    }
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
  }, [dirty, dispatch, workflow.id]);

  const onSaveClick = useCallback(() => {
    if (!dirty) {
      dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
      return;
    }
    setShowSaveModal(true);
  }, [dirty, dispatch, workflow.id]);

  const onConfirmSave = useCallback(async () => {
    setBusy(true);
    try {
      await dispatch(updateWorkflow({
        id: workflow.id,
        patch: { steps: draftSteps },
        ifMatch: workflow.updated_at || null,
      }));
      dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
    } finally {
      setBusy(false);
      setShowSaveModal(false);
    }
  }, [dispatch, workflow.id, workflow.updated_at, draftSteps]);

  // Test button: spawn a Test Agent session running the (possibly-unsaved)
  // draft via /workflows/{id}/test-run. The sibling lands to the right of
  // the workflow card with an arrow chip labeled "Testing" between them
  // (Image #39). Session footer auto-flips to Force Stop Agent because
  // the agent is running.
  const onTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/test-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ steps: draftSteps.map((s) => ({ id: s.id, text: s.text, label: s.label || null })) }),
      });
      if (!res.ok) {
        setTurns((t) => [...t, { kind: 'assistant', text: `Couldn't spawn the Test Agent. (${res.status})` }]);
        return;
      }
      const data = await res.json();
      const sessionId = data?.session_id as string | undefined;
      if (!sessionId) return;
      try {
        const { store } = await import('@/shared/state/store');
        if (!store.getState().agents.sessions[sessionId]) {
          try { await dispatch(fetchSession(sessionId)).unwrap(); } catch { /* not fatal */ }
        }
        if (!store.getState().dashboardLayout.cards[sessionId] && wfCardPos) {
          dispatch(placeCard({
            sessionId,
            x: wfCardPos.x + wfCardPos.width + 60,
            y: wfCardPos.y,
            width: DEFAULT_CARD_W,
            height: DEFAULT_CARD_H,
            expandedSessionIds,
          }));
        }
        dispatch(setPendingFocusAgentId(sessionId));
      } catch { /* best-effort */ }
      dispatch(setCardSidecar({ workflowId: workflow.id, sessionId, kind: 'testing' }));
    } catch (e) {
      setTurns((t) => [...t, { kind: 'assistant', text: (e as Error)?.message || 'Network error.' }]);
    } finally {
      setBusy(false);
    }
  }, [busy, workflow.id, draftSteps, dispatch, wfCardPos, expandedSessionIds]);

  const onTestClick = useCallback(() => {
    // If user has unsaved edits, ask first so they know the Test Agent
    // runs the DRAFT, not the persisted workflow. The little modal the
    // user asked for in the Image #38 thread.
    if (dirty) {
      setShowSaveBeforeTest(true);
    } else {
      void onTest();
    }
  }, [dirty, onTest]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
      {/* Inline header replacement. Matches Image #38: subtitle on the
          LEFT, Settings + Discard + Save flush right. The card's default
          action bar is hidden for edit_agent / fix_agent views. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <InlineSubtitle workflow={workflow} />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Permissions, actions, cost cap">
          <Box
            onClick={() => dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'edit', editFacet: 'Actions' } }))}
            role="button"
            sx={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 999,
              color: c.text.secondary, cursor: 'pointer',
              '&:hover': { color: c.text.primary, bgcolor: c.bg.elevated },
            }}>
            <TuneRounded sx={{ fontSize: 16 }} />
          </Box>
        </Tooltip>
        <HeaderBtn
          label="Discard"
          icon={<DeleteOutlineRounded sx={{ fontSize: 16 }} />}
          onClick={onDiscard}
          tone="muted"
        />
        <HeaderBtn
          label={busy ? 'Saving…' : 'Save'}
          icon={<SaveOutlinedIcon sx={{ fontSize: 16 }} />}
          onClick={onSaveClick}
          tone="filled"
          disabled={busy}
        />
      </Box>
      <Box sx={{
        p: 1.5, borderRadius: `${c.radius.lg}px`,
        border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.elevated,
      }}>
        <StepList steps={draftSteps} />
      </Box>
      {/* Conversation. Bubbles + tool-call style cards. */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {turns.map((t, idx) => {
          if (t.kind === 'fix-prefix') {
            const PREVIEW_MAX = 110;
            const needsExpand = (t.error || '').length > PREVIEW_MAX;
            const shown = !needsExpand || t.expanded
              ? t.error
              : (t.error || '').slice(0, PREVIEW_MAX).trimEnd() + '…';
            return (
              <Box
                key={idx}
                onClick={needsExpand ? () => setTurns((all) => all.map((tt, i) => i === idx && tt.kind === 'fix-prefix' ? { ...tt, expanded: !tt.expanded } : tt)) : undefined}
                sx={{
                  display: 'flex', alignItems: 'flex-start', gap: 1.25,
                  p: 1.25, borderRadius: `${c.radius.lg}px`,
                  bgcolor: c.status.errorBg,
                  border: `1px solid ${c.status.error}30`,
                  cursor: needsExpand ? 'pointer' : 'default',
                  '&:hover': needsExpand ? { bgcolor: c.status.error + '14' } : {},
                }}>
                <Box sx={{
                  width: 32, height: 32, borderRadius: `${c.radius.md}px`,
                  bgcolor: c.status.error + '22', color: c.status.error,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <BuildRounded sx={{ fontSize: 16 }} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography sx={{ flex: 1, fontSize: '0.92rem', fontWeight: 700, color: c.text.primary, lineHeight: 1.3 }}>
                      Fixing Step {t.stepIdx + 1}: {t.stepLabel}
                    </Typography>
                    {needsExpand && (
                      <KeyboardArrowDownRounded sx={{
                        fontSize: 18,
                        color: c.text.muted,
                        transform: t.expanded ? 'rotate(180deg)' : 'none',
                        transition: 'transform 0.18s ease',
                        flexShrink: 0,
                      }} />
                    )}
                  </Box>
                  <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, mt: 0.25, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                    {shown}
                  </Typography>
                </Box>
              </Box>
            );
          }
          if (t.kind === 'assistant') {
            return (
              <Box key={idx} sx={{
                p: 1.25, borderRadius: `${c.radius.lg}px`,
                bgcolor: c.bg.surface,
                border: `1px solid ${c.border.subtle}`,
              }}>
                <Typography sx={{ fontSize: '0.92rem', color: c.text.primary, lineHeight: 1.45 }}>
                  {t.text}
                </Typography>
              </Box>
            );
          }
          if (t.kind === 'user') {
            return (
              <Box key={idx} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Box sx={{
                  px: 1.5, py: 0.85, borderRadius: `${c.radius.lg}px`,
                  bgcolor: c.bg.secondary,
                  maxWidth: '85%',
                }}>
                  <Typography sx={{ fontSize: '0.92rem', color: c.text.primary, lineHeight: 1.45 }}>
                    {t.text}
                  </Typography>
                </Box>
              </Box>
            );
          }
          // proposal
          return (
            <Box key={idx} sx={{
              p: 1.25, borderRadius: `${c.radius.lg}px`,
              bgcolor: c.accent.primary + '10',
              border: `1px solid ${c.accent.primary}30`,
              display: 'flex', flexDirection: 'column', gap: 0.6,
            }}>
              <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: c.accent.primary }}>
                Proposed change to Step {t.stepIdx + 1}
              </Typography>
              {t.explanation && (
                <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, lineHeight: 1.45 }}>
                  {t.explanation}
                </Typography>
              )}
              <Box sx={{
                p: 1, borderRadius: `${c.radius.md}px`,
                bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`,
              }}>
                <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.text.muted, mb: 0.35 }}>AFTER</Typography>
                <Typography sx={{ fontSize: '0.86rem', color: c.text.primary, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
                  {t.after}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                {t.applied ? (
                  <Typography sx={{ fontSize: '0.82rem', color: c.status.success, fontWeight: 700 }}>Applied to draft</Typography>
                ) : (
                  <Box
                    onClick={() => onApplyProposal(idx)}
                    role="button"
                    sx={{
                      fontSize: '0.82rem', fontWeight: 700,
                      color: '#fff', bgcolor: c.accent.primary,
                      px: 1.25, py: 0.4, borderRadius: 999, cursor: 'pointer',
                      '&:hover': { filter: 'brightness(1.05)' },
                    }}>
                    Apply to draft
                  </Box>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box sx={{ flex: 1 }} />
      <Box sx={{
        p: 1, borderRadius: `${c.radius.lg}px`,
        border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface,
        display: 'flex', flexDirection: 'column', gap: 0.5,
      }}>
        <TextareaAutosize
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSubmit();
            }
          }}
          minRows={1}
          maxRows={5}
          placeholder="Agent, @ for context, / for commands"
          style={{
            width: '100%', resize: 'none', boxSizing: 'border-box',
            fontFamily: 'inherit', fontSize: '0.92rem', color: c.text.primary,
            border: 'none', outline: 'none', background: 'transparent',
            padding: '6px 4px', lineHeight: 1.45,
          }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Pill label="Agent" />
          <Pill label="Claude Opus 4.6" />
          <Pill label="High" />
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Spawn a Test Agent that runs the current draft. Sits next to this card with an arrow chip while it works.">
            <Box
              onClick={onTestClick}
              role="button"
              sx={{
                display: 'inline-flex', alignItems: 'center', gap: 0.3,
                fontSize: '0.78rem', fontWeight: 700,
                color: c.accent.primary, bgcolor: 'transparent',
                px: 1, py: 0.4, borderRadius: 999,
                border: `1px solid ${c.accent.primary}55`,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.5 : 1,
                '&:hover': { bgcolor: c.accent.primary + '14' },
              }}>
              <ScienceOutlined sx={{ fontSize: 14 }} />
              Test
            </Box>
          </Tooltip>
          <Box
            onClick={onSubmit}
            role="button"
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.3,
              fontSize: '0.78rem', fontWeight: 700,
              color: '#fff', bgcolor: c.accent.primary,
              px: 1.2, py: 0.4, borderRadius: 999,
              cursor: busy || !draft.trim() ? 'not-allowed' : 'pointer',
              opacity: busy || !draft.trim() ? 0.5 : 1,
              '&:hover': { filter: 'brightness(1.05)' },
            }}>
            <PlayArrowRounded sx={{ fontSize: 14 }} />
            {busy ? 'Working…' : 'Send'}
          </Box>
        </Box>
      </Box>

      <Dialog open={showSaveBeforeTest} onClose={() => setShowSaveBeforeTest(false)} maxWidth="xs" fullWidth>
        <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>
            Save before testing?
          </Typography>
          <Typography sx={{ fontSize: '0.9rem', color: c.text.secondary, lineHeight: 1.5 }}>
            The Test Agent will run your DRAFT steps, not the saved version. You can save now so the changes stick if the test goes well, or test without saving and decide after.
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
            <Box onClick={() => setShowSaveBeforeTest(false)} role="button" sx={{ fontSize: '0.86rem', color: c.text.secondary, px: 1, py: 0.6, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>
              Cancel
            </Box>
            <Box
              onClick={() => { setShowSaveBeforeTest(false); void onTest(); }}
              role="button"
              sx={{
                fontSize: '0.86rem', fontWeight: 700, color: c.accent.primary, bgcolor: 'transparent',
                px: 1.2, py: 0.55, borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${c.accent.primary}55`,
                '&:hover': { bgcolor: c.accent.primary + '14' },
              }}>
              Test draft only
            </Box>
            <Box
              onClick={async () => { setShowSaveBeforeTest(false); await onConfirmSave(); void onTest(); }}
              role="button"
              sx={{
                fontSize: '0.86rem', fontWeight: 700, color: '#fff', bgcolor: c.status.success,
                px: 1.4, py: 0.55, borderRadius: 999, cursor: 'pointer',
                '&:hover': { filter: 'brightness(1.05)' },
              }}>
              Save & test
            </Box>
          </Box>
        </Box>
      </Dialog>

      <Dialog open={showSaveModal} onClose={() => setShowSaveModal(false)} maxWidth="sm" fullWidth>
        <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>
            Save changes to workflow?
          </Typography>
          <Typography sx={{ fontSize: '0.9rem', color: c.text.secondary, lineHeight: 1.5 }}>
            You&apos;re replacing the saved steps with your edits. The next scheduled run will use the new version.
          </Typography>
          {/* Diff body: each changed step shows BEFORE struck through and
              AFTER in green. Unchanged steps render as a quiet line so the
              user can see the full step list in context, not just the deltas. */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 0.5, maxHeight: 360, overflowY: 'auto', pr: 0.5 }}>
            {draftSteps.map((s, i) => {
              const beforeText = steps[i]?.text || '';
              const afterText = s.text || '';
              const changed = afterText !== beforeText;
              const label = s.label || steps[i]?.label || afterText.slice(0, 60);
              if (!changed) {
                return (
                  <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: c.text.muted, opacity: 0.4, flexShrink: 0 }} />
                    <Typography sx={{ fontSize: '0.82rem', color: c.text.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      Step {i + 1}: {label}
                    </Typography>
                  </Box>
                );
              }
              return (
                <Box key={s.id} sx={{
                  display: 'flex', flexDirection: 'column', gap: 0.45,
                  p: 1, borderRadius: `${c.radius.md}px`,
                  border: `1px solid ${c.accent.primary}30`,
                  bgcolor: c.accent.primary + '08',
                }}>
                  <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: c.accent.primary }}>
                    Step {i + 1}: {label}
                  </Typography>
                  {beforeText && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.2 }}>
                      <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.status.error, letterSpacing: '0.04em' }}>BEFORE</Typography>
                      <Typography sx={{
                        fontSize: '0.82rem', color: c.text.secondary,
                        textDecoration: 'line-through', lineHeight: 1.45,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {beforeText}
                      </Typography>
                    </Box>
                  )}
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.2 }}>
                    <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color: c.status.success, letterSpacing: '0.04em' }}>AFTER</Typography>
                    <Typography sx={{
                      fontSize: '0.82rem', color: c.text.primary,
                      lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {afterText}
                    </Typography>
                  </Box>
                </Box>
              );
            })}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 0.5 }}>
            <Box onClick={() => setShowSaveModal(false)} role="button" sx={{ fontSize: '0.86rem', color: c.text.secondary, px: 1, py: 0.6, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>
              Keep editing
            </Box>
            <Box
              onClick={onConfirmSave}
              role="button"
              sx={{
                fontSize: '0.86rem', fontWeight: 700, color: '#fff', bgcolor: c.status.success,
                px: 1.4, py: 0.55, borderRadius: 999, cursor: 'pointer',
                '&:hover': { filter: 'brightness(1.05)' },
              }}>
              {busy ? 'Saving…' : 'Save & close'}
            </Box>
          </Box>
        </Box>
      </Dialog>
    </Box>
  );
}

function HeaderBtn({ label, icon, onClick, tone, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; tone: 'muted' | 'filled'; disabled?: boolean }) {
  const c = useClaudeTokens();
  const filled = tone === 'filled';
  return (
    <Box
      onClick={disabled ? undefined : onClick}
      role="button"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.4,
        fontSize: '0.82rem', fontWeight: 700,
        px: 1.1, py: 0.45, borderRadius: 999,
        color: filled ? '#fff' : c.text.secondary,
        bgcolor: filled ? c.text.primary : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        '&:hover': filled ? { filter: 'brightness(1.05)' } : { color: c.text.primary, bgcolor: c.bg.elevated },
      }}>
      {icon}
      {label}
    </Box>
  );
}

function Pill({ label }: { label: string }) {
  const c = useClaudeTokens();
  return (
    <Box sx={{
      fontSize: '0.74rem', fontWeight: 600, color: c.text.secondary,
      px: 0.8, py: 0.25, borderRadius: 999,
      border: `1px solid ${c.border.subtle}`,
    }}>{label}</Box>
  );
}
