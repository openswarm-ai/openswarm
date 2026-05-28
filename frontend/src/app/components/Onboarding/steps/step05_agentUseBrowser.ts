import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step05: OnboardingStep = {
  id: 'agent_use_browser',
  stage: 'learn_features',
  index: 5,
  title: 'Have an agent use the browser',
  description: 'Let an agent take control of your browser.',
  videoSrc: './onboarding-videos/v2/05.mp4',
  videoDurationLabel: '0:30',
  requiresDashboard: true,
  dependsOn: [{ stepId: 'use_browser', reopen: 'walk_again' }],
  ops: [
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Time for a fresh chat that surfs the web.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    // Offset (-10,-10): cursor SVG is asymmetric so default-center pins on the adjacent paperclip.
    { kind: 'move_to', target: S.elementSelectionToggle, offset: { x: -10, y: -10 } },
    { kind: 'popup', text: 'Tap here to plug a browser into this chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.elementSelectionToggle },
    },
    // Fit-to-view so chat + browser card are both visible for drag-select; autoFocusSessionId otherwise clips.
    { kind: 'move_to', target: S.canvasFitToView },
    { kind: 'click', target: S.canvasFitToView, simulate: true },
    { kind: 'delay', ms: 350 },
    { kind: 'drag_select', target: 'browser-card' },
    {
      kind: 'popup',
      text: 'Now you try! Drag a box around the browser to link it.',
    },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'agent:attached_to_browser' },
      timeoutMs: 90000,
    },
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'type_into',
      target: S.chatInput,
      text: 'Pull up the open swarm website (openswarm.com) and find the docs',
      speedMs: 12,
    },
    { kind: 'move_to', target: S.chatSendButton },
    { kind: 'click', target: S.chatSendButton, simulate: true },
    // Inline canvas-controls tour (hover + popup, no waits/clicks expected).
    { kind: 'move_to', target: S.canvasFitToView },
    { kind: 'popup', text: 'Heads up! This snaps everything back into view.' },
    { kind: 'delay', ms: 1800 },
    { kind: 'move_to', target: S.canvasTidyLayout },
    { kind: 'popup', text: 'And this auto tidies your layout.' },
    { kind: 'delay', ms: 1800 },
    { kind: 'move_to', target: S.canvasMinimapToggle },
    { kind: 'popup', text: 'Pop on a minimap whenever things get crowded.' },
    { kind: 'delay', ms: 1800 },
    { kind: 'outro' },
  ],
};
