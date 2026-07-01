// Deterministic FLOOR content for the payoff, keyed by persona. The real payoff is generated per-user
// (onboarding-suggest / onboarding-profile); this is the always-available fallback. Split to match
// the 3-beat payoff: a short insight (hello), one hero task, and 3 distinct alternatives.

import type { PersonaId, PayoffIdea } from './onboardingFlowTypes';

export interface PayoffContent {
  insight: string;
  hero: PayoffIdea;
  more: PayoffIdea[];
}

const WORK: PayoffContent = {
  insight: "Looks like a lot's on your plate between clients and admin.",
  hero: { id: 'briefing', icon: 'sun', label: 'Send me a morning briefing', prompt: 'Set up a daily morning briefing with my calendar and anything urgent in my email.' },
  more: [
    { id: 'invoices', icon: 'tray', label: 'Chase my overdue invoices', prompt: 'Find my overdue invoices and draft polite follow-ups, ready to send.' },
    { id: 'tracker', icon: 'build', label: 'Build me a client tracker', prompt: 'Build and run a simple client tracker I can add clients and statuses to.' },
    { id: 'competitors', icon: 'globe', label: 'Watch my competitors', prompt: 'Watch 3 competitor sites and notify me when they change.' },
  ],
};

const PERSONAL: PayoffContent = {
  insight: 'Life admin has a way of piling up.',
  hero: { id: 'week', icon: 'sun', label: 'Plan my week', prompt: 'Pull my calendar, flag any conflicts, and draft a simple to-do for what is due. Show me before saving.' },
  more: [
    { id: 'inbox', icon: 'tray', label: 'Sort out my inbox', prompt: 'Triage my inbox: surface what needs a reply and draft quick responses.' },
    { id: 'book', icon: 'globe', label: 'Find + book something', prompt: 'Find the best-rated option for what I need and walk me through booking it.' },
    { id: 'goal', icon: 'build', label: 'Track a personal goal', prompt: 'Build and run a simple tracker for a personal goal.' },
  ],
};

const BUILD: PayoffContent = {
  insight: 'Ideas are cheap, shipping is the thing.',
  hero: { id: 'prototype', icon: 'build', label: 'Turn my idea into a prototype', prompt: 'Ask me 3 quick questions, then build and run a first version I can actually click.' },
  more: [
    { id: 'stack', icon: 'globe', label: 'Research the best stack', prompt: 'Research and recommend the best stack for my idea, with tradeoffs.' },
    { id: 'spec', icon: 'doc', label: 'Draft a spec from my notes', prompt: 'Turn my rough notes into a clean, buildable spec.' },
    { id: 'board', icon: 'tray', label: 'Set up a task board', prompt: 'Build and run a simple task board for my project.' },
  ],
};

const GENERIC: PayoffContent = {
  insight: "Here's a taste of what I can actually do, not just chat about.",
  hero: { id: 'compare', icon: 'globe', label: 'Find + compare the best option', prompt: 'Find the 3 best-rated options for something under my budget, compare them, and tell me which to get.' },
  more: [
    { id: 'tool', icon: 'build', label: 'Build + run a small tool', prompt: 'Build and run a small tool from a one-sentence description.' },
    { id: 'digest', icon: 'sun', label: 'Set up a daily briefing', prompt: 'Set up a short daily briefing of what matters to me.' },
    { id: 'clean', icon: 'tray', label: 'Clean a messy list into a sheet', prompt: 'Turn a messy list into a clean, usable sheet.' },
  ],
};

export function demoPayoff(persona: PersonaId | null): PayoffContent {
  if (persona === 'work') return WORK;
  if (persona === 'personal') return PERSONAL;
  if (persona === 'build') return BUILD;
  return GENERIC;
}
