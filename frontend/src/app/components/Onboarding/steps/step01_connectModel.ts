import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasModelConnected } from './skipPredicates';

export const step01: OnboardingStep = {
  id: 'connect_model',
  stage: 'get_started',
  index: 1,
  title: 'Connect an AI model',
  description: 'This is the brain behind your agents.',
  videoSrc: './onboarding-videos/v2/01.mp4',
  videoDurationLabel: '0:24',
  skipIf: hasModelConnected,
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
