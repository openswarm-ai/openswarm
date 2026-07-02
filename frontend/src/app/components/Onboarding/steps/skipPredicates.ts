// skipIf predicates: true => step is already-done in current Redux state.

import type { RootState } from '@/shared/state/store';
import {
  hasAnyActiveSubscription,
} from '@/shared/state/subscriptionsSlice';

export function hasModelConnected(s: RootState): boolean {
  const d = s.settings.data as any;
  if (!d) return false;
  if (d.connection_mode === 'openswarm-pro' && d.openswarm_bearer_token) return true;
  if (
    d.anthropic_api_key ||
    d.openai_api_key ||
    d.google_api_key ||
    d.openrouter_api_key
  ) {
    return true;
  }
  // Custom OpenAI-compatible providers; api_key optional for local servers.
  const customs = (d.custom_providers || []) as any[];
  if (customs.some((cp) => cp?.name?.trim() && cp?.base_url?.trim())) {
    return true;
  }
  if (hasAnyActiveSubscription(s)) return true;
  return false;
}

/** True while the server-funded free trial is armed (no key needed yet). */
export function hasFreeTrialActive(s: RootState): boolean {
  const d = s.settings.data as any;
  return !!(d && d.connection_mode === 'free-trial' && d.free_trial_token);
}

/** True when free runs are running out (or already armed-and-spent). Surfaces the connect-model step. */
export function freeRunsLow(s: RootState): boolean {
  const d = s.settings.data as any;
  if (!d) return false;
  const remaining = d.free_trial_remaining;
  return typeof remaining === 'number' && remaining <= 2;
}

export function hasAnyToolEnabled(s: RootState): boolean {
  const items = s.tools?.items ?? {};
  // Match Tools.tsx Switch read: enabled !== false; pre-field tools treat undefined as on.
  return Object.values(items).some((t: any) => t?.enabled !== false);
}

/** True when a YouTube-shaped tool is on; step 2 waits on this so toggle-flapping stays in sync. */
export function isYoutubeEnabled(s: RootState): boolean {
  const items = s.tools?.items ?? {};
  return Object.values(items).some((t: any) => {
    const name = (t?.name ?? '').toLowerCase();
    const command = (t?.command ?? '').toLowerCase();
    const isYoutube = name === 'youtube' || command.includes('youtube');
    return isYoutube && t?.enabled !== false;
  });
}

export function hasAnyAgentLaunched(s: RootState): boolean {
  const sessions = s.agents?.sessions ?? {};
  // A draft is an unsent chat, not a launched agent. Counting drafts let the welcome draft pre-satisfy launch_agent at baseline-capture time, which froze the step as "pre-existing" so it never auto-completed, leaving "Launch your first Agent" stuck to-do after the chat.
  return Object.values(sessions).some((x: any) => x?.status && x.status !== 'draft');
}

/** True once any agent has actually FINISHED (not just started). Used to hold the
 *  onboarding reveal until after the first win, so it never pops mid-run. */
export function hasAnyAgentCompleted(s: RootState): boolean {
  const sessions = s.agents?.sessions ?? {};
  return Object.values(sessions).some((x: any) => x?.status === 'completed');
}

export function hasAnySkillInstalled(s: RootState): boolean {
  const items = s.skills?.items ?? [];
  if (Array.isArray(items)) return items.length > 0;
  return Object.keys(items).length > 0;
}

/** True if a browser card exists; step 4 auto-skips the open-a-browser walkthrough. */
export function hasAnyBrowserSpawned(s: RootState): boolean {
  const cards = (s as any).dashboardLayout?.browserCards ?? {};
  return Object.keys(cards).length > 0;
}
