import type { OnboardingStep, StepStage } from './types';
import { step01 } from './step01_connectModel';
import { step02 } from './step02_enableActions';
import { step03 } from './step03_launchAgent';
import { step04 } from './step04_useBrowser';
import { step05 } from './step05_agentUseBrowser';
import { step06 } from './step06_agentControlAgents';
import { step07 } from './step07_installSkill';
import { step08 } from './step08_makeApp';
import { welcomeOpenStep } from './step00_welcomeNudge';

// Value-first order: launch an agent (step03) FIRST so a brand-new user sees
// the product work on the free trial, then connect-your-own-model (step01).
// Everything else is "learn the features", revealed after the first win.
export const STEPS: OnboardingStep[] = [
  step03,
  step01,
  step02,
  step04,
  step05,
  step06,
  step07,
  step08,
];

// Resolvable by the Director but kept OUT of STEPS, so they never appear in the roadmap,
// the panel count, or the unlock chain. The first-run welcome nudge lives here.
const HIDDEN_STEPS: OnboardingStep[] = [welcomeOpenStep];

export function findStepById(id: string): OnboardingStep | undefined {
  return STEPS.find((s) => s.id === id) ?? HIDDEN_STEPS.find((s) => s.id === id);
}

export const STAGE_GROUPS: { stage: StepStage; steps: OnboardingStep[] }[] = [
  { stage: 'get_started', steps: STEPS.filter((s) => s.stage === 'get_started') },
  { stage: 'learn_features', steps: STEPS.filter((s) => s.stage === 'learn_features') },
];
