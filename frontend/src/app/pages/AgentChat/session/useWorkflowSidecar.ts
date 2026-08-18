import { useCallback } from 'react';
import { shallowEqual } from 'react-redux';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { stopAgent } from '@/shared/state/agentsSlice';
import { removeCard } from '@/shared/state/dashboardLayoutSlice';
import { setCardSidecar, commitDraft, updateWorkflowCard, controlWorkflowRun } from '@/shared/state/workflowsSlice';

// How this chat relates to a workflow card (AGENTCHAT_SPLIT_PLAN follow-up): the linked-sidecar
// selectors plus the stop/save/continue handlers that act on that link. Lifted verbatim from AgentChat.
export function useWorkflowSidecar(id: string | undefined) {
  const dispatch = useAppDispatch();
  // A card linked as a workflow sidecar (Test Agent, or a watched run) swaps its composer for a Force Stop button: continuing the chat is meaningless, but killing the run is the common need. Once a Test Agent finishes, the button flips to a green "close" (see workflow_test_state + ForceStopAgentBar).
  const linkedSidecar = useAppSelector((s) => {
    const found = Object.values(s.workflows.openCards).find(
      (cd) => cd.sidecarSessionId === id && (cd.sidecarKind === 'testing' || cd.sidecarKind === 'watching'),
    );
    return found
      ? { workflowId: found.workflowId, runId: found.runId ?? null, kind: found.sidecarKind ?? null }
      : null;
  }, shallowEqual);
  const linkedWorkflowId = linkedSidecar?.workflowId ?? null;
  const isStoppableSidecar = !!linkedWorkflowId;
  // A live workflow run being watched owns pause/resume from its workflow card, so the chat's own "Resume Agent Response" bubble is redundant and would go stale against the card's Resume. Suppress it for any workflow-run sidecar, not just the fragile exact "watching" value. Test-run sidecars keep their chat-level resume behavior.
  const isWorkflowRunSidecar = useAppSelector((s) => {
    if (!id) return false;
    for (const cd of Object.values(s.workflows.openCards)) {
      if (cd.sidecarSessionId !== id || cd.sidecarKind === 'testing') continue;
      if (cd.runId) {
        const run = (s.workflows.runs[cd.workflowId] || []).find((r) => r.id === cd.runId);
        if (!run || run.session_id === id) return true;
      }
      if (cd.sidecarKind === 'watching' || cd.sidecarKind === 'viewing-completed' || cd.sidecarKind === 'viewing-error') return true;
    }
    return Object.values(s.workflows.runs).some((runs) =>
      runs.some((r) => r.session_id === id && r.status === 'running'),
    );
  });
  const testState = useAppSelector((s) => (id ? s.agents.sessions[id]?.workflow_test_state : null) ?? null);

  const handleStop = useCallback(() => {
    if (!id) return;
    // A watched live workflow run mirrors the workflow card's Stop: fully stop the run, not just pause the agent. Test Agent + plain chats stop the session.
    if (linkedSidecar?.kind === 'watching' && linkedSidecar.runId) {
      dispatch(controlWorkflowRun({ runId: linkedSidecar.runId, action: 'stop' }));
      return;
    }
    dispatch(stopAgent({ sessionId: id }));
  }, [id, dispatch, linkedSidecar]);

  // Finished Test Agent card: drop the tether + remove this card, and either commit the workflow draft (Save, same as the edit card's "save now") or leave the draft untouched so the user keeps editing.
  const onTestContinueEditing = useCallback(() => {
    if (linkedWorkflowId) dispatch(setCardSidecar({ workflowId: linkedWorkflowId, sessionId: null, kind: null }));
    if (id) dispatch(removeCard(id));
  }, [linkedWorkflowId, id, dispatch]);

  const onTestSaveWorkflow = useCallback(async () => {
    if (linkedWorkflowId) {
      try {
        await dispatch(commitDraft(linkedWorkflowId)).unwrap();
      } catch {
        return;
      }
      dispatch(updateWorkflowCard({ workflowId: linkedWorkflowId, patch: { view: 'saved' } }));
      dispatch(setCardSidecar({ workflowId: linkedWorkflowId, sessionId: null, kind: null }));
    }
    if (id) dispatch(removeCard(id));
  }, [linkedWorkflowId, id, dispatch]);

  return { isStoppableSidecar, isWorkflowRunSidecar, testState, handleStop, onTestContinueEditing, onTestSaveWorkflow };
}
