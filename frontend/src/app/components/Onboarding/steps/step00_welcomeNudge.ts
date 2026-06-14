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
    { kind: 'delay', ms: 700 },                                                  // let the big POP land
    { kind: 'popup', text: 'Let me open up a chat for you.', dwellMs: 3000 },     // say it, hold ~3s (not the tour's 6s floor)
    { kind: 'move_to', target: S.newAgentButton },                               // dwell elapses, then travel to the chat bubble
    { kind: 'click', target: S.newAgentButton, simulate: true },                 // click -> spawns the welcome chat
    { kind: 'outro' },
  ],
};
