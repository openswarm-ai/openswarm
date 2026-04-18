import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import type { AgentConfig } from '@/shared/state/agentsTypes';
import {
  SEND_MESSAGE,
  STOP_AGENT,
  HANDLE_APPROVAL,
  EDIT_MESSAGE,
  GET_SESSION,
  META_LAUNCH_AND_SEND
} from '@/shared/backend-bridge/apps/agents';
import { updateSessionMode, updateSessionModel } from '@/shared/state/agentsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { setGlowingBrowserCards, fadeGlowingBrowserCards, clearGlowingBrowserCards } from '@/shared/state/dashboardLayoutSlice';

export interface QueuedMessage {
  prompt: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  selectedBrowserIds?: string[];
}

interface UseAgentChatParams {
  sessionId?: string;
}

export function useAgentChat({ sessionId: sessionIdProp }: UseAgentChatParams) {
  const { id: routeId } = useParams<{ id: string }>();
  const id = sessionIdProp || routeId;
  const dispatch = useAppDispatch();
  const session = useAppSelector((state) => (id ? state.agents.sessions[id] : undefined));
  const modesMap = useAppSelector((state) => state.modes.items);
  const [showResumeBubble, setShowResumeBubble] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const mode = session?.mode ?? 'agent';
  const model = session?.model ?? 'sonnet';
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const isDraft = session?.status === 'draft';

  useEffect(() => {
    if (!id || isDraft) return;
    dispatch(GET_SESSION(id));
  }, [id, isDraft, dispatch]);

  useEffect(() => { if (Object.keys(modesMap).length === 0) dispatch(fetchModes()); }, [dispatch, modesMap]);

  const sessionSystemPrompt = session?.system_prompt;
  const sessionTargetDirectory = session?.target_directory;

  const dispatchMessage = useCallback((msg: QueuedMessage) => {
    if (!id) return;
    setShowResumeBubble(false);
    setAwaitingResponse(true);
    if (isDraft) {
      const config: AgentConfig = { 
        model: model, 
        mode: mode,
        system_prompt: sessionSystemPrompt ?? undefined,
        target_directory: sessionTargetDirectory ?? undefined,
      };
      if (sessionSystemPrompt) config.system_prompt = sessionSystemPrompt;
      if (sessionTargetDirectory) config.target_directory = sessionTargetDirectory;
      dispatch(
        META_LAUNCH_AND_SEND({ 
          draftId: id,
          config,
          prompt: msg.prompt,
          mode,
          model,
          images: msg.images,
          contextPaths: msg.contextPaths,
          forcedTools: msg.forcedTools,
          attachedSkills: msg.attachedSkills,
          selectedBrowserIds: msg.selectedBrowserIds
        })
      ).then((action) => {
        if (META_LAUNCH_AND_SEND.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          // TODO: Implement title generation
          // dispatch(generateTitle({ 
          //   sessionId: realId,
          //   prompt: msg.prompt 
          // }));
          if (msg.selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ 
              browserIds: msg.selectedBrowserIds,
              sessionId: realId,
              label: 'Use Browser' 
            }));
          }
        }
      });
    } else {
      if (msg.selectedBrowserIds?.length) {
        dispatch(setGlowingBrowserCards({ browserIds: msg.selectedBrowserIds, sessionId: id, label: 'Use Browser' }));
      }
      dispatch(SEND_MESSAGE({ 
        sessionId: id, 
        prompt: msg.prompt, 
        mode: mode, 
        model: model, 
        images: msg.images?.map((img) => img.data),
        imageMediaTypes: msg.images?.map((img) => img.media_type),
        contextPaths: msg.contextPaths, 
        forcedTools: msg.forcedTools, 
        attachedSkills: msg.attachedSkills, 
        // TODO: Implement the selectedBrowserIds below
        // selectedBrowserIds: msg.selectedBrowserIds
      }))
        .then((action) => { if (SEND_MESSAGE.rejected.match(action)) setAwaitingResponse(false); });
    }
  }, [id, isDraft, mode, model, sessionSystemPrompt, sessionTargetDirectory, dispatch]);

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
        setTimeout(() => dispatch(clearGlowingBrowserCards(id)), 2800);
      }
      const nextQueued = messageQueueRef.current.shift();
      if (nextQueued) {
        setQueueLength(messageQueueRef.current.length);
        dispatchMessage(nextQueued);
        didDispatchQueued = true;
      } else if (curr === 'stopped') {
        setShowResumeBubble(true);
      }
      const currentMode = modesMap[mode];
      if (currentMode?.default_next_mode && modesMap[currentMode.default_next_mode]) {
        if (id && !isDraft) dispatch(updateSessionMode({ sessionId: id, mode: currentMode.default_next_mode }));
      }
    }
    if (curr === 'running') setShowResumeBubble(false);
    if (curr !== 'draft' && !didDispatchQueued) setAwaitingResponse(false);
  }, [session?.status, mode, modesMap, id, isDraft, dispatch, dispatchMessage]);

  const handleSend = (prompt: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>, forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => {
    if (!id) return;
    const msg: QueuedMessage = { prompt, images, contextPaths, forcedTools, attachedSkills, selectedBrowserIds };
    if (agentBusy) {
      messageQueueRef.current.push(msg);
      setQueueLength(messageQueueRef.current.length);
      return;
    }
    dispatchMessage(msg);
  };

  const handleModeChange = useCallback((newMode: string) => {
    if (id && !isDraft) dispatch(updateSessionMode({ sessionId: id, mode: newMode }));
  }, [id, isDraft, dispatch]);

  const handleModelChange = useCallback((newModel: string) => {
    if (id && !isDraft) dispatch(updateSessionModel({ sessionId: id, model: newModel }));
  }, [id, isDraft, dispatch]);

  const handleApprove = (requestId: string, updatedInput?: Record<string, unknown>) => {
    dispatch(HANDLE_APPROVAL({ requestId, behavior: 'allow', updatedInput }));
  };
  const handleDeny = (requestId: string, message?: string) => {
    dispatch(HANDLE_APPROVAL({ requestId, behavior: 'deny', message }));
  };
  const handleStop = () => { if (id) dispatch(STOP_AGENT(id)); };

  const handleResume = useCallback(() => {
    if (!id) return;
    setShowResumeBubble(false);
    dispatch(SEND_MESSAGE({
      sessionId: id,
      prompt: "Continue where you left off. Start you're response EXACTLY with 'Sorry, let me pick up where I left off",
      mode, model, hidden: true,
    }));
  }, [id, mode, model, dispatch]);

  const handleSaveEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!id) return;
      dispatch(EDIT_MESSAGE({ sessionId: id, messageId, content: newContent }));
      setEditingMessageId(null);
    }, [id, dispatch]
  );
  const handleCancelEdit = useCallback(() => { setEditingMessageId(null); }, []);

  return {
    id, 
    session, 
    isDraft, 
    dispatch, 
    mode, 
    model,
    messageQueueRef,
    showResumeBubble,
    awaitingResponse,
    editingMessageId,
    queueLength,
    setQueueLength,
    agentBusy,
    handleSend,
    handleModeChange,
    handleModelChange,
    handleApprove,
    handleDeny,
    handleStop,
    handleResume,
    handleSaveEdit,
    handleCancelEdit,
    setEditingMessageId,
  };
}
