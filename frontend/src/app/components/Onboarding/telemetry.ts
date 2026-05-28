// Wraps report() so all onboarding-v2 events land under surface='onboarding_v2'.

import { report as _report } from '@/shared/serviceClient';

let _stepStartTs: number | null = null;

export function markStepStarted(): void {
  _stepStartTs = Date.now();
}

export function clearStepTiming(): void {
  _stepStartTs = null;
}

export function report(
  action: string,
  props?: Record<string, unknown>,
): void {
  const enriched: Record<string, unknown> = { ...(props ?? {}) };
  if (_stepStartTs !== null) {
    enriched.ms_since_step = Date.now() - _stepStartTs;
  }
  _report('onboarding_v2', action, enriched);
}
