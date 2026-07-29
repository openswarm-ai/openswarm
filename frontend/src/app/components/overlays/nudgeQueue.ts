// One bottom-left nudge at a time. Priority: needs-you beats broken-login beats
// missed-runs beats offers; the next pill renders only once the current one is
// acted on or dismissed. Pure selector logic so each toast stays a dumb reader.

import { useAppSelector } from '@/shared/hooks';

export type NudgeKind = 'triggersHealth' | 'providerHealth' | 'missedRuns' | 'patterns';

const PRIORITY: NudgeKind[] = ['triggersHealth', 'providerHealth', 'missedRuns', 'patterns'];

export function useNudgeTurn(kind: NudgeKind): boolean {
  const open: Record<NudgeKind, boolean> = {
    triggersHealth: useAppSelector((s) => s.triggersHealth.toastOpen && s.triggersHealth.items.length > 0),
    providerHealth: useAppSelector((s) => s.subscriptions.healthToastOpen && s.subscriptions.healthDead.length > 0),
    missedRuns: useAppSelector((s) => s.missedRuns.toastOpen && s.missedRuns.items.length > 0),
    patterns: useAppSelector((s) => s.patterns.toastOpen && s.patterns.suggestions.length > 0),
  };
  for (const k of PRIORITY) {
    if (open[k]) return k === kind;
  }
  return false;
}
