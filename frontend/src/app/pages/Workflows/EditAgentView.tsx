// Image #38, #48: Edit Agent embedded in the workflow card.
// Creates a real, sticky-per-workflow agent session via /workflows/{id}/
// edit-agent-session and embeds AgentChat so tool calls render as their
// normal cards (MCP Activation, Gmail Query, etc.). The card IS the chat:
// a collapsible "Workflow" strip on top peeks at the live steps, the chat
// fills the rest. In fix mode (Image #48) the first message is a
// failure-context prompt and a red prefix card renders above the chat.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import BuildRounded from '@mui/icons-material/BuildRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearFixSeed, commitDraft, discardDraft, setCardSidecar, updateWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import { API_BASE, getAuthToken } from '@/shared/config';
import StepList from './StepList';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import { useOpenSidecar } from './WorkflowCardLiveViews';
import EditAgentSavePopovers, { type SavePhase } from './EditAgentSavePopovers';

interface Props {
  workflow: Workflow;
  steps: Workflow['steps'];
  isFixMode?: boolean;
  // The card header (in WorkflowCard) renders the model/time subtitle and the
  // Save Workflow button, so it needs the live edit-agent session id.
  onEditSessionIdChange?: (sessionId: string | null) => void;
}

export default function EditAgentView({ workflow, steps, isFixMode = false, onEditSessionIdChange }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const fixSeed = card?.fixSeed || null;
  const [stepsOpen, setStepsOpen] = useState(true);
  const [fixPrefixExpanded, setFixPrefixExpanded] = useState(false);
  const [editSessionId, setEditSessionId] = useState<string | null>(workflow.edit_agent_session_id || null);
  const [seedSent, setSeedSent] = useState(false);
  // Surface the live session id to the card header (Save button + model/time).
  useEffect(() => { onEditSessionIdChange?.(editSessionId); }, [editSessionId, onEditSessionIdChange]);
  // Clear the fix seed after the view unmounts so re-entering edit_agent
  // (without going through Fix-with-Agent) doesn't re-show the prefix.
  useEffect(() => () => { dispatch(clearFixSeed(workflow.id)); }, [dispatch, workflow.id]);

  // On entering edit, ALWAYS hit edit-agent-session once (not just when the
  // session is missing): the call reattaches the sticky chat AND, on the
  // backend, snapshots a fresh draft from the current committed steps. If we
  // skipped it when a session already existed (re-edit), the draft would never
  // be created and edits would leak onto the live workflow.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    let alive = true;
    (async () => {
      try {
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/edit-agent-session`, {
          method: 'POST',
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        const sid = data?.session_id as string | undefined;
        if (!sid || !alive) return;
        try { await dispatch(fetchSession(sid)).unwrap(); } catch { /* may not be hydrated yet */ }
        if (alive) setEditSessionId(sid);
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [workflow.id, dispatch]);

  // First-turn seed: post the hidden opener so the agent's first reply
  // is the friendly "How would you like to modify the workflow..." prompt
  // (or, in fix mode, an analysis of the failure context).
  const editSession = useAppSelector((s) => editSessionId ? s.agents.sessions[editSessionId] : undefined);
  useEffect(() => {
    if (!editSessionId || !editSession || seedSent) return;
    const msgs = editSession.messages || [];
    if (msgs.length > 0) {
      setSeedSent(true);
      return;
    }
    const seed = isFixMode && fixSeed
      ? `The most recent run failed on Step ${fixSeed.stepIdx + 1} (${fixSeed.stepLabel}). Error: ${fixSeed.error}\n\nWalk me through what likely went wrong and propose a concrete prompt change for that step.`
      // A brand-new workflow has no steps yet, so open in build mode ("what
      // should this do?") rather than the modify-an-existing-flow prompt.
      : steps.length === 0
        ? 'Greet me briefly, then ask: "What should this workflow do?"'
        : 'Greet me briefly, then ask: "How would you like to modify the workflow (e.g. filter out spam emails before summarizing)?"';
    setSeedSent(true);
    (async () => {
      try {
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        await fetch(`${API_BASE}/agents/sessions/${encodeURIComponent(editSessionId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
          body: JSON.stringify({ prompt: seed, hidden: true }),
        });
      } catch { /* best-effort */ }
    })();
  }, [editSessionId, editSession, seedSent, isFixMode, fixSeed, steps.length]);

  // Save flow: Save -> "test first?" popover -> optional test run -> "confirm
  // save" popover. The step edits are staged in workflow.draft_steps; commit
  // makes them live, discard throws them away.
  const openSidecar = useOpenSidecar(workflow.id);
  const [savePhase, setSavePhase] = useState<SavePhase>('idle');
  const [saveAnchorEl, setSaveAnchorEl] = useState<HTMLElement | null>(null);
  const [testSessionId, setTestSessionId] = useState<string | null>(null);
  const draftSteps = workflow.draft_steps ?? steps;
  const canSave = draftSteps.some((s) => (s.text || '').trim().length > 0);
  const allowDiscard = !workflow.unsaved;
  // A draft always exists in edit mode (we snapshot on entry), so only flag
  // "unsaved" once the draft actually diverges from the committed steps.
  const hasChanges = workflow.draft_steps != null && JSON.stringify(workflow.draft_steps) !== JSON.stringify(workflow.steps);

  const toSaved = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
  }, [dispatch, workflow.id]);

  const clearSidecar = useCallback(() => {
    dispatch(setCardSidecar({ workflowId: workflow.id, sessionId: null, kind: null }));
  }, [dispatch, workflow.id]);

  const stopTest = useCallback(async () => {
    if (!testSessionId) return;
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      await fetch(`${API_BASE}/agents/sessions/${encodeURIComponent(testSessionId)}/stop`, {
        method: 'POST', headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
    } catch { /* best-effort */ }
  }, [testSessionId]);

  const onSaveClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    setSaveAnchorEl(e.currentTarget);
    setSavePhase('ask-test');
  }, []);

  const onSaveNow = useCallback(async () => {
    if (!canSave) return;
    setSavePhase('idle');
    try {
      await dispatch(commitDraft(workflow.id)).unwrap();
    } catch {
      return;
    }
    toSaved();
  }, [canSave, dispatch, workflow.id, toSaved]);

  const onRunTest = useCallback(async () => {
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/test-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ steps: draftSteps }),
      });
      if (!res.ok) { setSavePhase('idle'); return; }
      const data = await res.json();
      const sid = data?.session_id as string | undefined;
      if (!sid) { setSavePhase('idle'); return; }
      setTestSessionId(sid);
      // The Test Agent card now owns the post-test decision (Continue editing /
      // Save workflow) in its own footer, so just close this popover.
      setSavePhase('idle');
      await openSidecar(sid, 'testing');
    } catch { setSavePhase('idle'); }
  }, [workflow.id, draftSteps, openSidecar]);

  const onDiscardClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    setSaveAnchorEl(e.currentTarget);
    setSavePhase('confirm-discard');
  }, []);

  const onConfirmDiscard = useCallback(async () => {
    setSavePhase('idle');
    if (testSessionId) { await stopTest(); clearSidecar(); }
    await dispatch(discardDraft(workflow.id));
    toSaved();
  }, [dispatch, workflow.id, testSessionId, stopTest, clearSidecar, toSaved]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* The "tab with the workflow inside": a collapsible strip that peeks
          at the live steps (they update as the agent edits) without leaving
          the chat. The header's Save Workflow button drops back to the card. */}
      <Box sx={{ flexShrink: 0, mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
          <Box
            onClick={() => setStepsOpen((x) => !x)}
            role="button"
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.25, cursor: 'pointer',
              fontSize: '0.82rem', fontWeight: 600, color: c.text.secondary,
              '&:hover': { color: c.text.primary },
            }}>
            <KeyboardArrowDownRounded sx={{ fontSize: 16, transform: stepsOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s ease' }} />
            Workflow ({draftSteps.length} step{draftSteps.length === 1 ? '' : 's'})
          </Box>
          {hasChanges && (
            <Typography sx={{ fontSize: '0.74rem', color: c.text.muted }}>· unsaved</Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {allowDiscard && (
            <Box
              onClick={onDiscardClick}
              role="button"
              sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.muted, cursor: 'pointer', mr: 1, '&:hover': { color: c.status.error } }}>
              Discard
            </Box>
          )}
          <Box
            onClick={canSave ? onSaveClick : undefined}
            role="button"
            title={canSave ? undefined : 'Add at least one step before saving'}
            sx={{
              fontSize: '0.8rem', fontWeight: 700, color: '#fff', bgcolor: c.accent.primary,
              px: 1.2, py: 0.35, borderRadius: 999, cursor: canSave ? 'pointer' : 'not-allowed',
              opacity: canSave ? 1 : 0.45,
              '&:hover': { filter: 'brightness(1.05)' },
            }}>
            Save
          </Box>
        </Box>
        {stepsOpen && (
          <Box sx={{ mt: 0.75 }}>
            <StepList steps={draftSteps} />
            {isFixMode && fixSeed && (
              <Box sx={{ mt: 0.75 }}>
                <FixPrefixCard seed={fixSeed} expanded={fixPrefixExpanded} onToggle={() => setFixPrefixExpanded((x) => !x)} />
              </Box>
            )}
          </Box>
        )}
      </Box>
      <EditAgentSavePopovers
        phase={savePhase}
        anchorEl={saveAnchorEl}
        onClose={() => setSavePhase('idle')}
        onSaveNow={onSaveNow}
        onRunTest={onRunTest}
        onConfirmDiscard={onConfirmDiscard}
      />
      {/* The card IS the chat. AgentChat owns the composer + message list +
          tool-call cards. Negative margins cancel the card body's p:2 so the
          thread runs edge-to-edge like a normal chat (it supplies its own px). */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', mx: -2, mb: -2 }}>
        {editSessionId ? (
          <AgentChat sessionId={editSessionId} embedded autoFocus />
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.muted, fontSize: '0.85rem' }}>
            Starting the Edit Agent...
          </Box>
        )}
      </Box>
    </Box>
  );
}

function FixPrefixCard({ seed, expanded, onToggle }: { seed: { stepIdx: number; stepLabel: string; error: string }; expanded: boolean; onToggle: () => void }) {
  const c = useClaudeTokens();
  const PREVIEW_MAX = 110;
  const needsExpand = (seed.error || '').length > PREVIEW_MAX;
  const shown = !needsExpand || expanded
    ? seed.error
    : (seed.error || '').slice(0, PREVIEW_MAX).trimEnd() + '...';
  return (
    <Box
      onClick={needsExpand ? onToggle : undefined}
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
            Fixing Step {seed.stepIdx + 1}: {seed.stepLabel}
          </Typography>
          {needsExpand && (
            <KeyboardArrowDownRounded sx={{
              fontSize: 18,
              color: c.text.muted,
              transform: expanded ? 'rotate(180deg)' : 'none',
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
