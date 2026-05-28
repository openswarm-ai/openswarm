import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step08: OnboardingStep = {
  id: 'make_app',
  stage: 'learn_features',
  index: 8,
  title: 'Make an App',
  description: 'Prompt interactive applications into existence.',
  videoSrc: './onboarding-videos/v2/08.mp4',
  videoDurationLabel: '0:42',
  ops: [
    { kind: 'move_to', target: S.sidebarApps },
    { kind: 'popup', text: 'Swing by Apps.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.sidebarApps },
    },
    { kind: 'move_to', target: S.appsNewButton },
    { kind: 'popup', text: 'Spin up a fresh one.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.appsNewButton },
    },
    // Wait for the SCOPED chat-input; survives cold-starts and the StrictMode mount/unmount/remount cycle.
    {
      kind: 'popup',
      text: 'Loading the App Builder...',
    },
    {
      kind: 'wait_for_dom',
      css: '[data-onboarding-scope="app-builder"] [data-onboarding="chat-input"]',
      timeoutMs: 60000,
    },
    { kind: 'delay', ms: 350 },
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'type_into',
      target: S.chatInput,
      text: 'Make me a pdf previewer app',
      speedMs: 12,
    },
    // 120ms pause lets onInput's draft-state commit before clicking; send-button is disabled-while-empty.
    { kind: 'delay', ms: 120 },
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    // chat:message_sent only; app:generation_done has too many legitimate completion shapes.
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 30000,
    },
    {
      kind: 'popup',
      text: "Cooking up your app! It'll pop up in a sec. Go explore while it brews.",
    },
    { kind: 'delay', ms: 4000 },
    { kind: 'outro' },
  ],
};
