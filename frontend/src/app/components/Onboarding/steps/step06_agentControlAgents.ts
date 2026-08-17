import type { OnboardingStep } from './types';
import { S } from '../selectors';

export const step06: OnboardingStep = {
  id: 'agent_control_agents',
  stage: 'learn_features',
  index: 6,
  title: 'Have an agent control other agents',
  description: 'Let an agent orchestrate other agents.',
  requiresDashboard: true,
  // Reuses step 3's chat as the orchestratee; step 6 always has one available by now.
  ops: [
    {
      kind: 'popup',
      text: "Remember the chat you just made? We'll have a fresh one boss it around.",
    },
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: "Make a new chat. This one's the boss." },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.newAgentButton },
    },
    // See step05 (cursor body offset).
    { kind: 'move_to', target: S.elementSelectionToggle, offset: { x: -10, y: -10 } },
    { kind: 'popup', text: 'Tap here to hook in the older chat.' },
    {
      kind: 'wait_user',
      condition: { kind: 'click_target', target: S.elementSelectionToggle },
    },
    // Fit-to-view (same reason as step 5).
    { kind: 'move_to', target: S.canvasFitToView },
    { kind: 'click', target: S.canvasFitToView, simulate: true },
    { kind: 'delay', ms: 350 },
    { kind: 'drag_select', target: 'agent-card' },
    {
      kind: 'popup',
      text: 'Now you try! Drag a box around the older chat to make it a helper.',
    },
    {
      kind: 'wait_user',
      // Reuses agent:attached_to_browser; backend emits it for any element-selection attach.
      condition: { kind: 'event_bus', event: 'agent:attached_to_browser' },
      timeoutMs: 90000,
    },
    // Guide, don't commandeer: let the user tell the boss chat what to do with the helper, in their own words, instead of auto-typing + sending for them.
    { kind: 'move_to', target: S.chatInput },
    {
      kind: 'popup',
      text: 'Tell the boss chat what to have its helper do, your words, then send.',
    },
    // Confirm a message went out; don't wait for the orchestrator to finish (legitimately runs minutes).
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 180000,
    },
    {
      kind: 'popup',
      text: "On it! The helper gets to work and reports back to the boss. Go poke around in the meantime.",
    },
    { kind: 'delay', ms: 4000 },
    { kind: 'outro' },
  ],
};
