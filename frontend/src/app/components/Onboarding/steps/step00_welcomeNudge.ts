import type { OnboardingStep } from './types';
import { S } from '../selectors';

// First-run, invisible to the roadmap: the cursor pops into existence (handled by fadeIn, with
// the orange spark), pauses a beat, then moves to and clicks the New Agent button, which spawns
// the welcome chat. Static, no LLM. The delays give the pop and the move room to breathe.
export const welcomeOpenStep: OnboardingStep = {
  id: 'welcome_open',
  stage: 'get_started',
  index: 0,
  title: 'Welcome',
  description: '',
  ops: [
    { kind: 'delay', ms: 900 },                                   // let the big POP land + breathe
    { kind: 'move_to', target: S.newAgentButton },
    { kind: 'popup', text: 'Let me open a chat for you.' },
    { kind: 'delay', ms: 350 },                                   // quick read, then click promptly
    { kind: 'click', target: S.newAgentButton, simulate: true },  // spawns the welcome chat
    { kind: 'outro' },
  ],
};
