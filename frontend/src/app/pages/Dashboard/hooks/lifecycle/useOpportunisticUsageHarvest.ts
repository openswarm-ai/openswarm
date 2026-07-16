import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { summarizeUsage, type ProviderUsage, type UsageProvider } from '@/shared/providerUsage';
import { runPrep } from '@/app/components/OnboardingV3/onboardingV3Api';

const HOST_PROVIDER: Array<{ host: string; provider: UsageProvider }> = [
  { host: 'chatgpt.com', provider: 'codex' },
  { host: 'claude.ai', provider: 'claude' },
];

function providerForUrl(url: string): UsageProvider | null {
  try {
    const host = new URL(url).hostname;
    for (const hp of HOST_PROVIDER) if (host === hp.host || host.endsWith('.' + hp.host)) return hp.provider;
  } catch { /* not a url */ }
  return null;
}

// The first-run provider login always escapes the app (magic-link / embed-block), so the ONLY moment the browser partition holds a readable session is when the user opens ChatGPT/Claude in an in-app card themselves. Catch exactly that: harvest silently offscreen, then re-feed prep so the saved greeting + starters sharpen to what they actually work on. At most one successful run per provider per session; a not-logged-in read (empty summary) leaves it armed to retry on the next visit.
export function useOpportunisticUsageHarvest(): void {
  const dispatch = useAppDispatch();
  const providerKey = useAppSelector((s) => {
    const found = new Set<string>();
    for (const card of Object.values(s.dashboardLayout.browserCards)) {
      for (const tab of card.tabs) { const p = providerForUrl(tab.url); if (p) found.add(p); }
    }
    return Array.from(found).sort().join(',');
  });
  const doneRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);

  useEffect(() => {
    if (!providerKey || busyRef.current) return;
    const provider = providerKey.split(',').find((p) => p && !doneRef.current.has(p)) as UsageProvider | undefined;
    if (!provider) return;
    const harvestUsage = window.openswarm?.harvestUsage;
    if (typeof harvestUsage !== 'function') return;
    busyRef.current = true;
    // Let the page settle so the session cookie is live before the offscreen read.
    const timer = window.setTimeout(async () => {
      try {
        const raw = (await harvestUsage(provider)) as ProviderUsage | null;
        const summary = summarizeUsage(raw);
        if (!summary) return;
        doneRef.current.add(provider);
        await dispatch(updateSettingsPatch({ personalized_usage_summary: summary }));
        const prep = await runPrep(null, [], [], summary);
        if (prep && prep.starters.length > 0) {
          await dispatch(updateSettingsPatch({
            personalized_greeting: prep.greeting || null,
            personalized_starters: prep.starters,
            personalized_automations: prep.automations,
          }));
        }
      } catch { /* fail-open */ }
      finally { busyRef.current = false; }
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [providerKey, dispatch]);
}
