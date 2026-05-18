// Onboarding-v2 step/op/advance-condition schema; ../ac/acRuntime.ts is the only executor.

import type { RootState } from '@/shared/state/store';

/** Matches data-onboarding="<v>" or data-select-type="<v>". */
export type Selector = string;

export type ACMultiChoiceOption = {
  id: string;
  label: string;
  /** If set, queue extra ops on selection so one step can branch without splitting. */
  thenOps?: ACOp[];
};

export type ACOp =
  | { kind: 'move_to'; target: Selector; offset?: { x: number; y: number } }
  | { kind: 'popup'; text: string; cta?: string }
  | { kind: 'multi_choice'; opId: string; question: string; options: ACMultiChoiceOption[] }
  | { kind: 'highlight_section'; target: Selector; popup?: string; durationMs?: number }
  | {
      kind: 'type_into';
      target: Selector;
      /** Static string or function evaluated once at op-execution; not reactive to subsequent state. */
      text: string | ((state: RootState) => string);
      speedMs?: number;
    }
  | { kind: 'click'; target: Selector; simulate?: boolean }
  | { kind: 'drag_select'; target: Selector }
  | { kind: 'wait_user'; condition: AdvanceCondition; hint?: string; timeoutMs?: number }
  | { kind: 'delay'; ms: number }
  /** Poll a raw CSS selector until it mounts, up to timeoutMs (step 8 uses for App Builder chat-input). */
  | { kind: 'wait_for_dom'; css: string; timeoutMs?: number }
  | { kind: 'outro' };

export type AdvanceCondition =
  | { kind: 'click_target'; target: Selector }
  | { kind: 'redux_predicate'; selector: (s: RootState) => unknown; equals?: unknown; truthy?: boolean }
  | { kind: 'event_bus'; event: string };

export type StepStage = 'get_started' | 'learn_features';

export interface StepDependency {
  stepId: string;
  reopen: 'walk_again' | 'just_resume';
}

export interface OnboardingStep {
  id: string;
  stage: StepStage;
  /** 1..N (currently 1..8). */
  index: number;
  title: string;
  description: string;
  videoSrc?: string;
  /** Shown in the panel preview chip, e.g. "0:24". */
  videoDurationLabel?: string;
  ops: ACOp[];
  dependsOn?: StepDependency[];
  /** Mark a step already-done at launch / Show me click without running its flow. */
  skipIf?: (state: RootState) => boolean;
  /** True when ops target dashboard-toolbar elements; runtime auto-prepends a click-into-dashboard hop. */
  requiresDashboard?: boolean;
}

export const STAGE_LABELS: Record<StepStage, string> = {
  get_started: 'Get started',
  learn_features: 'Learn the features',
};
