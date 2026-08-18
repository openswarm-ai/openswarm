import { useCallback, useEffect, useRef, useState } from 'react';

export interface FreeTrialNotice {
  kind: 'connect' | 'spent';
  label: string;
}

// Owns the two model-switch toast states + their auto-clear timers (workflow-run-model change, and the
// free-trial "can't use this model" warning). Each show() replaces any pending timer; the notices fade
// themselves out after the window. Timers are cleared on unmount.
export interface ModelSwitchNotices {
  workflowNotice: string | null;
  freeTrialNotice: FreeTrialNotice | null;
  showWorkflow: (label: string) => void;
  showFreeTrial: (kind: 'connect' | 'spent', label: string) => void;
  clearFreeTrial: () => void;
}

export function useModelSwitchNotices(): ModelSwitchNotices {
  const [workflowNotice, setWorkflowNotice] = useState<string | null>(null);
  const workflowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [freeTrialNotice, setFreeTrialNotice] = useState<FreeTrialNotice | null>(null);
  const freeTrialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showWorkflow = useCallback((label: string) => {
    setWorkflowNotice(label);
    if (workflowTimer.current) clearTimeout(workflowTimer.current);
    workflowTimer.current = setTimeout(() => setWorkflowNotice(null), 5000);
  }, []);

  const showFreeTrial = useCallback((kind: 'connect' | 'spent', label: string) => {
    setFreeTrialNotice({ kind, label });
    if (freeTrialTimer.current) clearTimeout(freeTrialTimer.current);
    freeTrialTimer.current = setTimeout(() => setFreeTrialNotice(null), 6000);
  }, []);

  // Picked a usable model: drop any stale free-trial notice now (fades out in ~220ms) instead of letting it sit out its timer.
  const clearFreeTrial = useCallback(() => {
    setFreeTrialNotice(null);
    if (freeTrialTimer.current) clearTimeout(freeTrialTimer.current);
  }, []);

  useEffect(() => () => {
    if (workflowTimer.current) clearTimeout(workflowTimer.current);
    if (freeTrialTimer.current) clearTimeout(freeTrialTimer.current);
  }, []);

  return { workflowNotice, freeTrialNotice, showWorkflow, showFreeTrial, clearFreeTrial };
}
