import type { OnboardingStep } from './types';
import { S } from '../selectors';
import { hasAnyAgentLaunched, hasModelConnected, hasFreeTrialActive } from './skipPredicates';

export const step03: OnboardingStep = {
  id: 'launch_agent',
  stage: 'get_started',
  // Value first: this leads WHEN there's a way to run (free trial armed, or a
  // model connected). With nothing to run on, it skips so connect-model leads
  // instead, which restores today's flow exactly (no trial = no regression).
  index: 1,
  title: 'Launch your first Agent',
  description: 'Tell the chat what you want done and a team gets to work.',
  videoSrc: './onboarding-videos/v2/03.mp4',
  videoDurationLabel: '0:24',
  skipIf: (s) => hasAnyAgentLaunched(s) || (!hasModelConnected(s) && !hasFreeTrialActive(s)),
  requiresDashboard: true,
  // The cursor opens the chat FOR the user, then asks what they want. No canned
  // prompt and no LLM here: it's a static move + simulated click + a hardcoded
  // line; the user types their own thing and their team runs.
  ops: [
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Let me open a chat for you.' },
    { kind: 'click', target: S.newAgentButton, simulate: true },
    { kind: 'move_to', target: S.chatInput },
    { kind: 'popup', text: "What do you want done? Type it here and I'll put a team on it." },
    {
      kind: 'wait_user',
      condition: { kind: 'event_bus', event: 'chat:message_sent' },
      timeoutMs: 180000,
    },
    { kind: 'outro' },
  ],
};
