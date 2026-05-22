// Image #38, #48: Edit Agent embedded in the workflow card.
// Creates a real, sticky-per-workflow agent session via /workflows/{id}/
// edit-agent-session and embeds AgentChat so tool calls render as their
// normal cards (MCP Activation, Gmail Query, etc.). Header keeps the
// subtitle on the left and Settings + Discard + Save on the right. In
// fix mode (Image #48) the very first message in the session is a
// failure-context prompt, and a red prefix card renders above the chat
// so the user sees Why we're here at a glance.

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import Tooltip from '@mui/material/Tooltip';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import BuildRounded from '@mui/icons-material/BuildRounded';
import TuneRounded from '@mui/icons-material/TuneRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import ScienceOutlined from '@mui/icons-material/ScienceOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearFixSeed, setCardSidecar, updateWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
import { DEFAULT_CARD_W, DEFAULT_CARD_H, placeCard } from '@/shared/state/dashboardLayoutSlice';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import StepList from './StepList';
import { API_BASE, getAuthToken } from '@/shared/config';
import AgentChat from '@/app/pages/AgentChat/AgentChat';

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

export default function EditAgentView({ workflow, steps, isFixMode = false }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.workflows.openCards[workflow.id]);
  const wfCardPos = useAppSelector((s) => s.dashboardLayout.workflowCards[workflow.id]);
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);
  const fixSeed = card?.fixSeed || null;
  const [busy, setBusy] = useState(false);
  const [showSaveBeforeTest, setShowSaveBeforeTest] = useState(false);
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

  const onClose = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
  }, [dispatch, workflow.id]);

  const onTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/test-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ steps: steps.map((s) => ({ id: s.id, text: s.text, label: s.label || null })) }),
      });
      if (!res.ok) return;
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
    } finally {
      setBusy(false);
    }
  }, [busy, workflow.id, steps, dispatch, wfCardPos, expandedSessionIds]);

  const onTestClick = useCallback(() => {
    // No local draft to warn about anymore (the Edit Agent's tool will
    // mutate workflow.steps directly when wired). Skip the modal for now.
    void onTest();
  }, [onTest]);
  void showSaveBeforeTest; void setShowSaveBeforeTest;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: '100%' }}>
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
        <Tooltip title="Spawn a Test Agent that runs the latest workflow next to this card with a Testing arrow chip.">
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
        <HeaderBtn
          label="Discard"
          icon={<DeleteOutlineRounded sx={{ fontSize: 16 }} />}
          onClick={onClose}
          tone="muted"
        />
        <HeaderBtn
          label="Save"
          icon={<SaveOutlinedIcon sx={{ fontSize: 16 }} />}
          onClick={onClose}
          tone="filled"
        />
      </Box>
      <Box sx={{
        p: 1.5, borderRadius: `${c.radius.lg}px`,
        border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.elevated,
      }}>
        <StepList steps={steps} />
      </Box>
      {isFixMode && fixSeed && <FixPrefixCard seed={fixSeed} expanded={fixPrefixExpanded} onToggle={() => setFixPrefixExpanded((x) => !x)} />}
      {/* Embedded real Edit Agent chat. AgentChat owns the composer +
          message list + tool-call card rendering, matching Image #48
          (MCP Activation, Gmail Query, etc.). embedded=true tells it to
          skip its own dashboard chrome since we own the surrounding card. */}
      <Box sx={{ flex: 1, minHeight: 280, display: 'flex', flexDirection: 'column', mx: -1, mb: -1 }}>
        {editSessionId ? (
          <AgentChat sessionId={editSessionId} embedded autoFocus />
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.muted, fontSize: '0.85rem' }}>
            Starting the Edit Agent...
          </Box>
        )}
      </Box>

      <Dialog open={false} onClose={() => {}} maxWidth="sm" fullWidth>
        <Box />
      </Dialog>
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
