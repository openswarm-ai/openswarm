import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { API_BASE, getAuthToken } from '@/shared/config';
import {
  sendMessage as sendMessageThunk,
  launchAndSendFirstMessage,
  generateTitle,
  updateSessionMode,
  clearSessionMessages,
  type AgentSession,
} from '@/shared/state/agentsSlice';
import { setGlowingBrowserCards, fadeGlowingBrowserCards, clearGlowingBrowserCards } from '@/shared/state/dashboardLayoutSlice';
import type { useMessageQueue, QueuedMessage } from '../queue/useMessageQueue';

// The send/turn pipeline (AGENTCHAT_SPLIT_PLAN follow-up): dispatching a message (draft launch vs live
// send vs run-context question), the busy gate, the terminal-status transition (drain queue / show
// resume / auto-advance mode), resume + reset-history, and the pre-send activity label. Lifted verbatim
// from AgentChat; every callback returned here is a stable useCallback whose identity feeds ChatInput's
// memo (callback-identity rule — destructure members, never dep on this hook's return object).
export function useSendPipeline({
  id,
  isDraft,
  session,
  mode,
  model,
  setMode,
  modesMap,
  queue,
  isWorkflowRunSidecar,
  streamingMessageId,
  onSendRunQuestion,
}: {
  id: string | undefined;
  isDraft: boolean;
  session: AgentSession | undefined;
  mode: string;
  model: string;
  setMode: (mode: string) => void;
  modesMap: Record<string, any>;
  queue: ReturnType<typeof useMessageQueue>;
  isWorkflowRunSidecar: boolean;
  streamingMessageId: string | null;
  onSendRunQuestion?: (prompt: string, runId: string) => Promise<void>;
}) {
  const dispatch = useAppDispatch();
  const [showResumeBubble, setShowResumeBubble] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [preSendActivityLabel, setPreSendActivityLabel] = useState<string | null>(null);

  useEffect(() => {
    if (isWorkflowRunSidecar) setShowResumeBubble(false);
  }, [isWorkflowRunSidecar]);

  // Read live in the stable dispatchMessage closure without busting its memo (ChatInput leans on handleSend identity holding across renders).
  const onSendRunQuestionRef = useRef(onSendRunQuestion);
  onSendRunQuestionRef.current = onSendRunQuestion;

  const dispatchMessage = useCallback((msg: QueuedMessage) => {
    if (!id) return;
    setShowResumeBubble(false);
    setAwaitingResponse(true);
    if (isDraft) {
      const config: Record<string, any> = { model, mode };
      if (session?.system_prompt) config.system_prompt = session.system_prompt;
      if (session?.target_directory) config.target_directory = session.target_directory;
      // Carry the draft's dashboard so the launched session stays ON this dashboard; without it the session lands dashboard_id=null, drops out of the reconcile filter, and its card vanishes the instant you send (looked like "the chat quit when I clicked an option").
      if (session?.dashboard_id) config.dashboard_id = session.dashboard_id;
      // Editing an existing app: bind the launch to it so the backend edits in place instead of seeding a duplicate empty app (App Builder mode only).
      if (msg.selectedAppIds?.length) config.selected_app_output_ids = msg.selectedAppIds;
      dispatch(
        launchAndSendFirstMessage({ draftId: id, config, prompt: msg.prompt, mode, model, images: msg.images, contextPaths: msg.contextPaths, forcedTools: msg.forcedTools, attachedSkills: msg.attachedSkills, selectedBrowserIds: msg.selectedBrowserIds, selectedAppIds: msg.selectedAppIds, selectedSettingIds: msg.selectedSettingIds })
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt: msg.prompt }));
          if (msg.selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));
          }
        }
      });
    } else if (msg.attachedRunId && onSendRunQuestionRef.current) {
      // Run-context question: the backend folds the run transcript into this one turn and echoes the user bubble + answer over WS, so no optimistic thunk.
      onSendRunQuestionRef.current(msg.prompt, msg.attachedRunId).catch(() => setAwaitingResponse(false));
    } else {
      if (msg.selectedBrowserIds?.length) {
        dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: id, label: 'Use Browser' }));
      }
      dispatch(sendMessageThunk({ sessionId: id, prompt: msg.prompt, mode, model, images: msg.images, contextPaths: msg.contextPaths, forcedTools: msg.forcedTools, attachedSkills: msg.attachedSkills, selectedBrowserIds: msg.selectedBrowserIds, selectedAppIds: msg.selectedAppIds, selectedSettingIds: msg.selectedSettingIds }))
        .then((action) => {
          if (sendMessageThunk.rejected.match(action)) {
            setAwaitingResponse(false);
          }
        });
    }
  }, [id, isDraft, mode, model, session?.system_prompt, session?.target_directory, session?.dashboard_id, dispatch]);

  const agentBusy = awaitingResponse || (!isDraft && (session?.status === 'running' || session?.status === 'waiting_approval'));

  const prevStatusRef = useRef(session?.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = session?.status;
    prevStatusRef.current = curr;
    let didDispatchQueued = false;

    const wasActive = prev === 'running' || prev === 'waiting_approval';
    const isTerminal = curr === 'completed' || curr === 'stopped' || curr === 'error';

    if (wasActive && isTerminal) {
      if (id) {
        dispatch(fadeGlowingBrowserCards(id));
        setTimeout(() => dispatch(clearGlowingBrowserCards(id)), 600);
      }

      const nextQueued = queue.drainNext();
      if (nextQueued) {
        dispatchMessage(nextQueued);
        didDispatchQueued = true;
      } else {
        if (curr === 'stopped') {
          setShowResumeBubble(!isWorkflowRunSidecar);
        }
      }

      const currentMode = modesMap[mode];
      if (currentMode?.default_next_mode && modesMap[currentMode.default_next_mode]) {
        setMode(currentMode.default_next_mode);
        if (id && !isDraft) {
          dispatch(updateSessionMode({ sessionId: id, mode: currentMode.default_next_mode as any }));
        }
      }
    }
    if (curr === 'running') {
      setShowResumeBubble(false);
    }
    if (curr !== 'draft' && !didDispatchQueued) {
      setAwaitingResponse(false);
    }
  }, [session?.status, mode, modesMap, id, isDraft, dispatch, dispatchMessage, isWorkflowRunSidecar]);

  // A reload remounts past the live running->stopped transition that first shows the resume button, so re-derive it once from the persisted 'stopped' status (transcript-gated so a cleared chat can't resurrect it).
  const resumeHydratedRef = useRef(false);
  useEffect(() => {
    if (resumeHydratedRef.current) return;
    if (session?.status === 'stopped' && (session?.messages?.length ?? 0) > 0) {
      resumeHydratedRef.current = true;
      setShowResumeBubble(true);
    }
  }, [session?.status, session?.messages?.length]);

  useEffect(() => {
    if (
      streamingMessageId ||
      session?.turn_label?.label ||
      session?.status === 'completed' ||
      session?.status === 'error' ||
      session?.status === 'stopped'
    ) {
      setPreSendActivityLabel(null);
    }
  }, [streamingMessageId, session?.turn_label?.label, session?.status]);

  const handleResume = useCallback(() => {
    if (!id) return;
    setShowResumeBubble(false);
    dispatch(sendMessageThunk({
      sessionId: id,
      prompt: "Continue your previous response from exactly where it was cut off. Do not repeat anything you already wrote; pick up mid-sentence if you need to and keep going.",
      mode,
      model,
      hidden: true,
    }));
  }, [id, mode, model, dispatch]);

  const clearQueue = queue.clear;
  const handleResetHistory = useCallback(async () => {
    if (!id) return;
    const sid = id;
    // Reset local UI state first; clearSessionMessages only touches Redux session.messages, so showResumeBubble/awaitingResponse/the queue otherwise survive and a "thinking" or "Resume agent response" bubble lingers on a now-empty chat.
    setShowResumeBubble(false);
    setAwaitingResponse(false);
    clearQueue();
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      await fetch(`${API_BASE}/agents/sessions/${sid}/clear`, { method: 'POST', headers });
    } catch { /* surfaced via context_status */ }
    dispatch(clearSessionMessages(sid));
  }, [id, dispatch, clearQueue]);

  return {
    dispatchMessage,
    agentBusy,
    awaitingResponse,
    showResumeBubble,
    preSendActivityLabel,
    setPreSendActivityLabel,
    handleResume,
    handleResetHistory,
  };
}
