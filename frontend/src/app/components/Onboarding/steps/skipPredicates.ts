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
  return Object.keys(sessions).length > 0;
}

export function hasAnySkillInstalled(s: RootState): boolean {
  const items = s.skills?.items ?? [];
  if (Array.isArray(items)) return items.length > 0;
  return Object.keys(items).length > 0;
}

/** True if PDF skill installed (id/name/command); step 7 uses this so other skills don't auto-skip. */
export function hasPdfSkillInstalled(s: RootState): boolean {
  const items = s.skills?.items as any;
  const list: any[] = Array.isArray(items) ? items : Object.values(items ?? {});
  return list.some((sk: any) => {
    const id = (sk?.id ?? '').toString().toLowerCase();
    const name = (sk?.name ?? '').toString().toLowerCase();
    const cmd = (sk?.command ?? '').toString().toLowerCase();
    return id.includes('pdf') || name.includes('pdf') || cmd.includes('pdf');
  });
}

/** True if a browser card exists; step 4 auto-skips the open-a-browser walkthrough. */
export function hasAnyBrowserSpawned(s: RootState): boolean {
  const cards = (s as any).dashboardLayout?.browserCards ?? {};
  return Object.keys(cards).length > 0;
}
