import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasModelConnected, hasFreeTrialActive, freeRunsLow } from './skipPredicates';

export const step01: OnboardingStep = {
  id: 'connect_model',
  stage: 'get_started',
  // Moved to last in "Get started": the user only meets this after they've seen value, framed as "keep going". Stays suppressed while the free trial is armed and runs aren't low; un-suppresses when they're about to run out.
  index: 2,
  title: 'Keep going: connect your model',
  description: 'Your free runs are limited. Add your own model to keep building.',
  skipIf: (s) => hasModelConnected(s) || (hasFreeTrialActive(s) && !freeRunsLow(s)),
  ops: [
    { kind: 'move_to', target: S.sidebarSettingsButton },
    { kind: 'popup', text: 'Pop into Settings.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarSettingsButton },
    },
    { kind: 'move_to', target: S.settingsModelsTab },
    { kind: 'popup', text: 'Hop over to Models.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.settingsModelsTab },
    },
    {
      kind: 'multi_choice',
      opId: 'connect_method',
      question: 'How would you like to connect an AI model?',
      options: [
        {
          id: 'pro',
          label: 'Open Swarm Pro subscription',
          thenOps: [
            { kind: 'move_to', target: S.settingsProSection },
            { kind: 'popup', text: 'Hit Subscribe and pick a tier.' },
          ],
        },
        {
          id: 'subscription',
          label: 'I already have an AI subscription',
          thenOps: [
            { kind: 'move_to', target: S.settingsExternalSubs },
            { kind: 'popup', text: 'Hook up your subscription here.' },
          ],
        },
        {
          id: 'api_key',
          label: 'I have an API key',
          thenOps: [
            { kind: 'move_to', target: S.settingsApiKeys },
            { kind: 'popup', text: 'Drop your API key in.' },
          ],
        },
      ],
    },
    {
      kind: 'wait_user',
      condition: {
        kind: 'redux_predicate',
        selector: hasModelConnected,
        truthy: true,
      },
      hint: 'Finish connecting your model.',
    },
    { kind: 'move_to', target: S.settingsCloseButton },
    { kind: 'popup', text: 'Nice! Close it up.' },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'settings:closed' },
    },
    { kind: 'outro' },
  ],
};
