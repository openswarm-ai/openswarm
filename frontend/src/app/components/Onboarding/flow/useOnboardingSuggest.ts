// Generates the payoff content (insight + task + 4 options) from the user's persona via the cheap
// LLM. Exposes status so the payoff can show a brief "thinking" state, then stream the result in.
// Fail-open: on any miss the status goes 'failed' and the caller shows its static floor.

import { useEffect, useState } from 'react';
import { API_BASE } from '@/shared/config';

export interface SuggestDto {
  insight: string;
  task: string;
  options: { label: string; prompt: string }[];
}

export type SuggestStatus = 'idle' | 'loading' | 'ready' | 'failed';

export function useOnboardingSuggest(persona: string, name: string, active: boolean): { result: SuggestDto | null; status: SuggestStatus } {
  const [result, setResult] = useState<SuggestDto | null>(null);
  const [status, setStatus] = useState<SuggestStatus>('idle');

  useEffect(() => {
    if (!active || !persona) return;
    let cancelled = false;
    setStatus('loading');
    fetch(`${API_BASE}/agents/onboarding-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona, name }),
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
  }, [active, persona, name]);

  return { result, status };
}
