import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { isYoutubeEnabled } from './skipPredicates';

export const step02: OnboardingStep = {
  id: 'enable_actions',
  stage: 'get_started',
  index: 2,
  title: 'Enable agentic actions',
  description: 'Allow agents to work across your apps.',
  videoSrc: './onboarding-videos/v2/02.mp4',
  videoDurationLabel: '0:24',
  // Narrowed to YouTube so users with other tools still get walked; step 3 needs YouTube on.
  skipIf: isYoutubeEnabled,
  ops: [
    { kind: 'move_to', target: S.sidebarActions },
    { kind: 'popup', text: 'Peek at Actions.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarActions },
    },
    // YouTube on the throughline; step 3 needs it. Waits on Redux state, not click, so toggling stays synced.
    { kind: 'move_to', target: S.actionsYoutubeToggle },
    { kind: 'popup', text: 'Flip YouTube on.' },
    {
      kind: 'wait_user',
      condition: {
        kind: 'redux_predicate',
        selector: isYoutubeEnabled,
        truthy: true,
      },
      timeoutMs: 90000,
    },
    { kind: 'move_to', target: S.actionsYoutubeChevron },
    { kind: 'popup', text: 'Tap to peek inside.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.actionsYoutubeChevron },
    },
    { kind: 'move_to', target: S.actionsPermissionToggle },
    {
      kind: 'popup',
      text: 'Wanna fine tune what each action can do? Right here.',
    },
    { kind: 'delay', ms: 3500 },
    { kind: 'outro' },
  ],
};
