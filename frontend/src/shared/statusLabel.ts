/** Plain-English session status for user-facing chips; the raw enum values read as dev-speak. */
export function friendlyStatusLabel(status: string): string {
  switch (status) {
    case 'running': return 'working';
    case 'waiting_approval': return 'needs your OK';
    case 'completed': return 'done';
    case 'error': return 'needs attention';
    default: return status.replace(/_/g, ' ');
  }
}

interface CardStatusSource {
  status: string;
  queued?: boolean;
  reconnect_wait?: { at: string } | null;
  rate_limited?: { at: string } | null;
  provider_retrying?: { at: string } | null;
}

/** The collapsed card's one status word. A running turn that is really waiting on something says what, so "working" never covers a lost connection or a throttle the expanded chat's pills would show. */
export function cardStatusWord(s: CardStatusSource): string {
  if (s.status === 'running') {
    if (s.reconnect_wait) return 'waiting for connection';
    if (s.rate_limited) return 'rate limited';
    if (s.provider_retrying) return 'provider busy';
    // "queued" already means an unsent message in the composer chip; the admission gate gets its own words.
    if (s.queued) return 'waiting to start';
  }
  return friendlyStatusLabel(s.status);
}
