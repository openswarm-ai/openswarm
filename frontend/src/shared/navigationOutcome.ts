// Pure verdict for one navigation attempt, decided from URLs alone, so "Navigated to" can never
// again be printed while the document is provably still parked on the old page (Haik's field report).
export type NavOutcome =
  | { kind: 'ok'; url: string }
  | { kind: 'redirected'; url: string; requested: string }
  | { kind: 'stuck'; url: string; requested: string };

// Trailing-slash-insensitive, so loadURL("https://x.com") over "https://x.com/" doesn't read as "never moved".
export function sameDoc(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

export function navigationOutcome(requested: string, before: string, landed: string): NavOutcome {
  if (!before || sameDoc(requested, before)) return { kind: 'ok', url: landed || requested };
  if (!landed || sameDoc(landed, before)) return { kind: 'stuck', url: landed || before, requested };
  if (!sameDoc(landed, requested)) return { kind: 'redirected', url: landed, requested };
  return { kind: 'ok', url: landed };
}

/** The error a navigate returns when Chromium refused the load outright (unsafe port, DNS, connection refused): the guest then shows its own empty document, which reads as "a blank page" unless the agent is told. */
export function loadFailureError(requested: string, failure: string): { error: string; url: string } {
  return {
    error: `Navigation to ${requested} FAILED (${failure}). The browser is showing its empty error document, not the site; retry once, and if it fails again report the failure instead of describing the page.`,
    url: requested,
  };
}
