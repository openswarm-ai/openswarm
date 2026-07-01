// Generates the payoff content (insight + task + 4 options) from the user's persona via the cheap
// free-trial LLM. Progressive: returns null until it lands, so the payoff shows its static floor
// first and swaps to the personalized version when ready. Fail-open on any miss.

import { useEffect, useState } from 'react';
import { API_BASE } from '@/shared/config';

export interface SuggestDto {
  insight: string;
  task: string;
  options: { label: string; prompt: string }[];
}

export function useOnboardingSuggest(persona: string, name: string, active: boolean): SuggestDto | null {
  const [result, setResult] = useState<SuggestDto | null>(null);

  useEffect(() => {
    if (!active || !persona) return;
    let cancelled = false;
    fetch(`${API_BASE}/agents/onboarding-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona, name }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SuggestDto | null) => {
        if (!cancelled && data && data.insight?.trim() && data.task?.trim() && Array.isArray(data.options) && data.options.length > 0) {
          setResult(data);
        }
      })
      .catch(() => { /* fail-open: keep the floor */ });
    return () => { cancelled = true; };
  }, [active, persona, name]);

  return result;
}
