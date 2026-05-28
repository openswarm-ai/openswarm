import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  setPanelMode,
  setCurrentStep,
  markStepCompleted,
  clearJustCompleted,
  setRunning,
  recordMultiChoice,
  resetTour,
  type PanelMode,
} from '@/shared/state/onboardingProgressSlice';

export function useOnboardingProgress() {
  const state = useAppSelector((s) => s.onboardingProgress);
  const dispatch = useAppDispatch();

  return {
    ...state,
    setPanelMode: (m: PanelMode) => dispatch(setPanelMode(m)),
    setCurrentStep: (id: string | null) => dispatch(setCurrentStep(id)),
    markCompleted: (id: string) => dispatch(markStepCompleted(id)),
    clearJustCompleted: () => dispatch(clearJustCompleted()),
    setRunning: (running: boolean) => dispatch(setRunning(running)),
    recordMultiChoice: (stepId: string, opId: string, answerId: string) =>
      dispatch(recordMultiChoice({ stepId, opId, answerId })),
    resetTour: () => dispatch(resetTour()),
  };
}
