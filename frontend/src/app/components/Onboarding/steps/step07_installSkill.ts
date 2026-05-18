import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasPdfSkillInstalled } from './skipPredicates';

export const step07: OnboardingStep = {
  id: 'install_skill',
  stage: 'learn_features',
  index: 7,
  title: 'Install a skill',
  description: 'Teach agents how to handle specific tasks.',
  videoSrc: './onboarding-videos/v2/07.mp4',
  videoDurationLabel: '0:24',
  // Narrowed to PDF so other-skill users still walk through this demo.
  skipIf: hasPdfSkillInstalled,
  ops: [
    { kind: 'move_to', target: S.sidebarSkills },
    { kind: 'popup', text: 'Wander into Skills.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarSkills },
    },
    { kind: 'move_to', target: S.skillItemPdf },
    { kind: 'popup', text: 'Pick the PDF one.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.skillItemPdf },
    },
    { kind: 'move_to', target: S.skillInstallButton },
    { kind: 'popup', text: 'Install it!' },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'skill:installed' },
      timeoutMs: 60000,
    },
    {
      kind: 'popup',
      text: 'Boom! Now any chat is way better with PDFs.',
    },
    { kind: 'move_to', target: S.skillBuilderFab },
    { kind: 'click', target: S.skillBuilderFab, simulate: true },
    {
      kind: 'popup',
      text: 'Got an idea? Type it here and the skill builder whips one up.',
    },
    { kind: 'delay', ms: 3500 },
    { kind: 'outro' },
  ],
};
