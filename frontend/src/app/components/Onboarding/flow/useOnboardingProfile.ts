// Fires the read-only profiling agent in the BACKGROUND once the payoff is active, and returns its
// result only when it's genuinely useful. Truthful-or-silent: an empty/failed observation stays
// null, so the payoff keeps its persona floor and never shows a fabricated "I see you're...".

import { useEffect, useState } from 'react';
import { API_BASE } from '@/shared/config';
import type { ProfileResultDto } from './onboardingFlowTypes';

export function useOnboardingProfile(name: string, consent: boolean, active: boolean): ProfileResultDto | null {
  const [result, setResult] = useState<ProfileResultDto | null>(null);

  useEffect(() => {
    if (!active || !consent) return;
    let cancelled = false;
    fetch(`${API_BASE}/agents/onboarding-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, consent }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ProfileResultDto | null) => {
        // Only surface it if the observation is real (non-empty) and options came back.
        if (!cancelled && data && typeof data.observation === 'string' && data.observation.trim() && Array.isArray(data.options) && data.options.length > 0) {
          setResult(data);
        }
      })
      .catch(() => { /* fail-open: keep the floor */ });
    return () => { cancelled = true; };
  }, [active, consent, name]);

  return result;
}
