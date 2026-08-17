export interface ModelErrorInputs {
  isOnline: boolean;
  settingsKnown: boolean;
  settingsSettled: boolean;
  modelsOk: boolean;
  hasModel: boolean;
  freeTrialArmSettled: boolean;
  freeTrialActive: boolean;
  freeTrialSpent: boolean;
}

export type ModelErrorState = 'offline' | 'backend' | 'no-model' | null;

// Priority ladder for the red pill: offline is its own signal, an unreachable backend means we
// KNOW nothing about models (never claim "not configured" on missing data, that was the lying
// banner), and "no model" only fires once every loading gate has genuinely settled.
export function modelErrorState(i: ModelErrorInputs): ModelErrorState {
  if (!i.isOnline) return 'offline';
  if (i.settingsSettled && !i.settingsKnown) return 'backend';
  const noModel = i.settingsKnown && i.modelsOk && i.freeTrialArmSettled
    && !i.hasModel && !i.freeTrialActive && !i.freeTrialSpent;
  return noModel ? 'no-model' : null;
}
