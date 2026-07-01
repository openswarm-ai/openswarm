// Generates the payoff content (insight + task + 4 options) from the user's persona via the cheap
// LLM. Fires as soon as the persona is known (not at the payoff), so it runs in the BACKGROUND while
// the user goes through name/consent/connect and is ready by the time they land. Fail-open: on any
// miss the status goes 'failed' and the caller shows its static floor. Name isn't used here (the task
// content doesn't need it; the greeting adds the name separately), so it never re-fires mid-flow.

import { useEffect, useState } from 'react';
import { API_BASE } from '@/shared/config';

export interface SuggestDto {
  insight: string;
  task: string;
  options: { label: string; prompt: string }[];
}

export type SuggestStatus = 'idle' | 'loading' | 'ready' | 'failed';

export function useOnboardingSuggest(persona: string): { result: SuggestDto | null; status: SuggestStatus } {
  const [result, setResult] = useState<SuggestDto | null>(null);
  const [status, setStatus] = useState<SuggestStatus>('idle');

  useEffect(() => {
    if (!persona) return;
    let cancelled = false;
    setStatus('loading');
    fetch(`${API_BASE}/agents/onboarding-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SuggestDto | null) => {
        if (cancelled) return;
        if (data && data.insight?.trim() && data.task?.trim() && Array.isArray(data.options) && data.options.length > 0) {
          setResult(data);
          setStatus('ready');
        } else {
          setStatus('failed');
        }
      })
      .catch(() => { if (!cancelled) setStatus('failed'); });
    return () => { cancelled = true; };
  }, [persona]);

  return { result, status };
}
