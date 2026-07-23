import { Search, Hammer, Globe, CalendarClock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Two-level starters shared by the empty-state and the first-run welcome chat: pick a category, then a concrete prompt. Chosen to SHOWCASE what only OpenSwarm can do, and to feel PERSONAL: the agents can see the user's own computer/files, drive the browser, build real apps, and run recurring routines on a schedule, none of which a plain chatbot can do out of the box. Many prompts deliberately touch the user's own stuff so it matters to them. One-click-runnable (no [placeholders]); reads plainly for a non-dev. Labels name the END RESULT, not the mechanism. The 'build' category (target 'app-builder') prefills the composer since the agent builds the app in-place (CreateApp drops a live card); the 'schedule' category (target 'schedule') hands off to the automation chips, which turn a pick into a real scheduled workflow.
export type StarterCategory = {
  id: string;
  label: string;
  Icon: LucideIcon;
  prompts: string[];
  target?: 'app-builder' | 'schedule';
};

export const STARTER_CATEGORIES: StarterCategory[] = [
  {
    // Deep web research that ends in a real artifact (PDF, slideshow) + the parallel canvas.
    id: 'research', label: 'Research', Icon: Search,
    prompts: [
      'Plan a 3-day Tokyo trip and turn it into a printable PDF itinerary',
      'Make a slideshow presentation on black holes',
      "Look at what I've been working on lately and write me a quick recap",
      'Send 3 agents to plan my weekend at once: where to eat, what to do, what to watch',
    ],
  },
  {
    // Full live apps built from the user's OWN stuff, not toy snippets a chatbot just prints.
    id: 'build', label: 'Build an app', Icon: Hammer, target: 'app-builder',
    prompts: [
      'Make me Minecraft I can play right now',
      'Build me a personal site from my resume',
      'Turn a spreadsheet on my computer into a live dashboard',
      'Build a habit tracker that remembers my streaks between visits',
    ],
  },
  {
    // The browser agent: OpenSwarm's most powerful tool, it actually drives the web for you.
    id: 'browse', label: 'Use the web', Icon: Globe,
    prompts: [
      'Send an agent to find the cheapest flights to Tokyo and show me the best options',
      'Have an agent hunt down the best price on something I want to buy',
      'Find and screenshot the top-rated coffee shops in my city',
      'Watch an agent sign me up for a free newsletter on a site',
    ],
  },
  {
    // Recurring routines on a real schedule: the pick hands off to AutomationChips (target 'schedule'),
    // which shows THIS user's tailored automations and turns a click into a scheduled workflow. Label
    // names the payoff (a brief waiting for you), not the machinery. No inline prompts: the chips own them.
    id: 'schedule', label: 'Daily brief', Icon: CalendarClock, target: 'schedule',
    prompts: [],
  },
];
