// Image #49: the scheduling chat embedded in the workflow card.
// Mirrors EditAgentView: a sticky-per-workflow agent session (via
// /workflows/{id}/schedule-agent-session) interprets the user's cadence
// ("every Wednesday at 1pm") itself and commits via UpdateScheduledWorkflow,
// which is force-gated to "ask" so the commit shows up as a real ApprovalBar
// tool card in the chat. No deterministic pre-parse: the cadence is a model
// decision. Once the schedule turns enabled, we drop back to the saved view.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateWorkflowCard, type Workflow } from '@/shared/state/workflowsSlice';
import { fetchSession } from '@/shared/state/agentsSlice';
import { API_BASE, getAuthToken } from '@/shared/config';
import StepList from './StepList';
import AgentChat from '@/app/pages/AgentChat/AgentChat';

interface Props {
  workflow: Workflow;
  steps: Workflow['steps'];
}

export default function SchedulingView({ workflow, steps }: Props) {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [stepsOpen, setStepsOpen] = useState(true);
  const [scheduleSessionId, setScheduleSessionId] = useState<string | null>(workflow.schedule_agent_session_id || null);
  const [seedSent, setSeedSent] = useState(false);

  // Spawn (or reattach to) the sticky scheduling-agent session on mount.
  useEffect(() => {
    if (scheduleSessionId) return;
    let alive = true;
    (async () => {
      try {
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        const res = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflow.id)}/schedule-agent-session`, {
          method: 'POST',
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        const sid = data?.session_id as string | undefined;
        if (!sid || !alive) return;
        try { await dispatch(fetchSession(sid)).unwrap(); } catch { /* may not be hydrated yet */ }
        if (alive) setScheduleSessionId(sid);
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [scheduleSessionId, workflow.id, dispatch]);

  // First-turn seed: hidden opener so the agent's first reply is the
  // figma's "When should this workflow run..." question.
  const scheduleSession = useAppSelector((s) => scheduleSessionId ? s.agents.sessions[scheduleSessionId] : undefined);
  useEffect(() => {
    if (!scheduleSessionId || !scheduleSession || seedSent) return;
    const msgs = scheduleSession.messages || [];
    if (msgs.length > 0) {
      setSeedSent(true);
      return;
    }
    setSeedSent(true);
    (async () => {
      try {
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        const cadenceHint = workflow.suggested_cadence ? ` I think it should run ${workflow.suggested_cadence}.` : '';
        const prompt = `Greet me in one short sentence, then ask exactly: "When should this workflow run (e.g. every Wednesday at 1pm)?"${cadenceHint}`;
        await fetch(`${API_BASE}/agents/sessions/${encodeURIComponent(scheduleSessionId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
          body: JSON.stringify({
            prompt,
            hidden: true,
          }),
        });
      } catch { /* best-effort */ }
    })();
  }, [scheduleSessionId, scheduleSession, seedSent]);

  // Drop back to the saved view once a commit lands. The scheduling agent
  // only PATCHes through the approved tool call, so a changed updated_at
  // with the schedule now enabled means the user approved it. Comparing
  // against the mount-time value avoids bouncing out on entry (e.g. when
  // rescheduling a workflow that was already enabled).
  const initialUpdatedAt = useRef(workflow.updated_at);
  useEffect(() => {
    if (workflow.schedule?.enabled && workflow.updated_at !== initialUpdatedAt.current) {
      dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
    }
  }, [workflow.schedule?.enabled, workflow.updated_at, workflow.id, dispatch]);

  const onCancel = useCallback(() => {
    dispatch(updateWorkflowCard({ workflowId: workflow.id, patch: { view: 'saved' } }));
  }, [dispatch, workflow.id]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Collapsible "here's the workflow" strip peeks at the read-only steps
          without leaving the chat; Cancel drops back to the saved card. */}
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
            onClick={onCancel}
            role="button"
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.4,
              fontSize: '0.8rem', fontWeight: 600, color: c.text.muted, cursor: 'pointer',
              '&:hover': { color: c.status.error },
            }}>
            <DeleteOutlineRounded sx={{ fontSize: 15 }} />
            Cancel task scheduling
          </Box>
        </Box>
        {stepsOpen && (
          <Box sx={{ mt: 0.75 }}>
            <StepList steps={steps} />
          </Box>
        )}
      </Box>
      {/* The card IS the chat. Negative margins cancel the card body's p:2 so
          the thread (and the ApprovalBar tool card) runs edge-to-edge. */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', mx: -2, mb: -2 }}>
        {scheduleSessionId ? (
          <AgentChat sessionId={scheduleSessionId} embedded autoFocus />
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.muted, fontSize: '0.85rem' }}>
            Starting...
          </Box>
        )}
      </Box>
    </Box>
  );
}
