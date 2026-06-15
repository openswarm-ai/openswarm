// Image #38, #48: Edit Agent embedded in the workflow card.
// Creates a real, sticky-per-workflow agent session via /workflows/{id}/
// edit-agent-session and embeds AgentChat so tool calls render as their
// normal cards (MCP Activation, Gmail Query, etc.). The card IS the chat:
// a collapsible "Workflow" strip on top peeks at the live steps, the chat
// fills the rest. In fix mode (Image #48) the first message is a
// failure-context prompt and a red prefix card renders above the chat.

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import BuildRounded from '@mui/icons-material/BuildRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearFixSeed, updateWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import { API_BASE, getAuthToken } from '@/shared/config';
import StepList from './StepList';
import AgentChat from '@/app/pages/AgentChat/AgentChat';

interface Props {
  workflow: Workflow;
  steps: Workflow['steps'];
  isFixMode?: boolean;
}

export default function EditAgentView({ workflow, steps, isFixMode = false }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const fixSeed = card?.fixSeed || null;
  const [stepsOpen, setStepsOpen] = useState(true);
  const [fixPrefixExpanded, setFixPrefixExpanded] = useState(false);
  const [editSessionId, setEditSessionId] = useState<string | null>(workflow.edit_agent_session_id || null);
  const [seedSent, setSeedSent] = useState(false);
  // Clear the fix seed after the view unmounts so re-entering edit_agent
  // (without going through Fix-with-Agent) doesn't re-show the prefix.
  useEffect(() => () => { dispatch(clearFixSeed(workflow.id)); }, [dispatch, workflow.id]);

  // Spawn (or reattach to) the sticky Edit Agent session on mount.
  useEffect(() => {
    if (editSessionId) return;
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
  }, [editSessionId, workflow.id, dispatch]);

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
  }, [editSessionId, editSession, seedSent, isFixMode, fixSeed]);

  const onDone = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
  }, [dispatch, workflow.id]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* The "tab with the workflow inside": a collapsible strip that peeks
          at the live steps (they update as the agent edits) without leaving
          the chat. Done drops back to the compact workflow card. */}
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
            Workflow ({steps.length} step{steps.length === 1 ? '' : 's'})
          </Box>
          <Box sx={{ flex: 1 }} />
          <Box
            onClick={onDone}
            role="button"
            sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.muted, cursor: 'pointer', '&:hover': { color: c.text.primary } }}>
            Done
          </Box>
        </Box>
        {stepsOpen && (
          <Box sx={{ mt: 0.75 }}>
            {isFixMode && fixSeed && <FixPrefixCard seed={fixSeed} expanded={fixPrefixExpanded} onToggle={() => setFixPrefixExpanded((x) => !x)} />}
            <StepList steps={steps} />
          </Box>
        )}
      </Box>
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

