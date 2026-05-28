import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasAnyBrowserSpawned } from './skipPredicates';

export const step04: OnboardingStep = {
  id: 'use_browser',
  stage: 'get_started',
  index: 4,
  title: 'Use the built-in browser',
  description:
    'No more jumping between apps. You and your agents work in one place.',
  videoSrc: './onboarding-videos/v2/04.mp4',
  videoDurationLabel: '0:18',
  // Auto-skip if a browser card already exists.
  skipIf: hasAnyBrowserSpawned,
  requiresDashboard: true,
  ops: [
    { kind: 'move_to', target: S.browserButton },
    { kind: 'popup', text: 'Pop open a browser.' },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'browser:spawned' },
      timeoutMs: 60000,
    },
    { kind: 'outro' },
  ],
};
