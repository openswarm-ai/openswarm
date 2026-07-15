import type { OnboardingStep } from './types';
import { S } from '../selectors';

// App Builder is folded into normal agents now: the user just asks an agent to build
// an app and its live card drops on the canvas. So this step points at the dashboard
// composer instead of the old /apps page. We guide, we don't type or auto-send.
export const step08: OnboardingStep = {
  id: 'make_app',
  stage: 'learn_features',
  index: 8,
  title: 'Make an App',
  description: 'Prompt interactive applications into existence.',
  videoSrc: './onboarding-videos/v2/08.mp4',
  videoDurationLabel: '0:42',
  ops: [
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'popup',
      text: 'Apps are just something you ask for. Try "build me a habit tracker" — any agent can make one.',
    },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 180000,
    },
    {
      kind: 'popup',
      text: "Cooking up your app! It'll pop onto the canvas as a live card in a sec. Go explore while it brews.",
    },
    { kind: 'delay', ms: 4000 },
    { kind: 'outro' },
  ],
};
