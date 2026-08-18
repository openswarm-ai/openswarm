import { useCallback, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSessionMode, updateSessionModel, updateSessionThinkingLevel, updateThinkingLevel, type AgentSession } from '@/shared/state/agentsSlice';
import { fetchModes } from '@/shared/state/modesSlice';
import { useModelSwitchNotices } from '../model/useModelSwitchNotices';

// The composer's mode/model/thinking selection state and its change handlers, including the free-trial
// and workflow-model-switch notice policy (AGENTCHAT_SPLIT_PLAN follow-up). Lifted verbatim from
// AgentChat.
export function useModeModel({
  id,
  isDraft,
  session,
  workflowEditId,
  connectionMode,
}: {
  id: string | undefined;
  isDraft: boolean;
  session: AgentSession | undefined;
  workflowEditId?: string;
  connectionMode: string | undefined;
}) {
  const dispatch = useAppDispatch();
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);
  const modesMap = useAppSelector((state) => state.modes.items);
  const freeTrialRemaining = useAppSelector((s) => s.settings.data.free_trial_remaining);
  // Seed from the loaded session so a mounted chat doesn't pay a mode/model reconcile render (the effects below still track later changes); the literals are the fresh-draft defaults.
  const [mode, setMode] = useState(session?.mode ?? 'agent');
  const [model, setModel] = useState(session?.model ?? 'opus-5');
  // Workflow build chat only ("this model now runs the workflow") + free-trial "can't use this model" toasts, with their auto-clear timers.
  const {
    workflowNotice,
    freeTrialNotice,
    showWorkflow,
    showFreeTrial,
    clearFreeTrial,
  } = useModelSwitchNotices();

  // Stored value → curated picker label, with a tidy fallback for unknowns.
  const resolveModelLabel = useCallback((value: string | null | undefined): string => {
    if (!value) return '';
    for (const models of Object.values(modelsByProvider)) {
      for (const m of models as any[]) {
        if (m.value === value) return m.label;
      }
    }
    let s = String(value);
    if (s.startsWith('or:')) s = s.slice(3);
    if (s.includes('/')) s = s.split('/').pop() || s;
    return s;
  }, [modelsByProvider]);

  useEffect(() => {
    if (session) setMode(session.mode);
  }, [session?.mode]);

  useEffect(() => {
    if (session) setModel(session.model);
  }, [session?.model]);

  useEffect(() => {
    if (Object.keys(modesMap).length === 0) dispatch(fetchModes());
  }, [dispatch, modesMap]);

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    if (id && !isDraft) dispatch(updateSessionMode({ sessionId: id, mode: newMode }));
  }, [id, isDraft, dispatch]);

  const handleModelChange = useCallback((newModel: string) => {
    // On the trial only Haiku is funded; picking anything else needs a connected provider, and once runs are spent nothing local works, so warn and keep the funded model instead of snagging.
    if (connectionMode === 'free-trial') {
      const kind: 'connect' | 'spent' | null =
        (freeTrialRemaining ?? 0) <= 0 ? 'spent' : (newModel !== 'haiku' ? 'connect' : null);
      if (kind) {
        showFreeTrial(kind, resolveModelLabel(newModel));
        return;
      }
    }
    if (workflowEditId && newModel !== model) {
      showWorkflow(resolveModelLabel(newModel));
    }
    clearFreeTrial();
    setModel(newModel);
    if (id && !isDraft) dispatch(updateSessionModel({ sessionId: id, model: newModel }));
  }, [id, isDraft, dispatch, workflowEditId, model, resolveModelLabel, connectionMode, freeTrialRemaining, showFreeTrial, showWorkflow, clearFreeTrial]);

  const handleThinkingLevelChange = useCallback((level: 'off' | 'low' | 'medium' | 'high' | 'auto') => {
    if (!id) return;
    dispatch(updateSessionThinkingLevel({ sessionId: id, level }));
    if (!isDraft) dispatch(updateThinkingLevel({ sessionId: id, level }));
  }, [id, isDraft, dispatch]);

  return {
    mode,
    setMode,
    model,
    modesMap,
    resolveModelLabel,
    handleModeChange,
    handleModelChange,
    handleThinkingLevelChange,
    workflowNotice,
    freeTrialNotice,
  };
}
