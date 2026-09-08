/** What the pill says while the CLI retries. One word ("busy") used to cover a router that was not
 * answering at all, which is half of the fleet's retries and nothing the provider did. */
export function providerRetryLabel(kind: string | null | undefined, attempt: number | null | undefined): string {
  const head = (() => {
    switch (kind) {
      case 'unreachable': return "Can't reach the model, retrying";
      case 'rate_limit': return 'Rate limited, retrying';
      case 'auth': return 'Login rejected, retrying';
      case 'provider_error': return 'Provider error, retrying';
      default: return 'Provider busy, retrying';
    }
  })();
  return attempt ? `${head} (attempt ${attempt})` : head;
}

export function providerRetryHint(kind: string | null | undefined): string {
  switch (kind) {
    case 'unreachable': return 'The request got no answer at all: the model router on this machine is restarting or the network dropped. The agent keeps trying on its own.';
    case 'rate_limit': return 'The provider asked us to slow down; the agent waits it out and continues on its own.';
    case 'auth': return 'The provider rejected the login on this attempt; if it keeps happening, reconnect the model in Settings.';
    default: return 'The AI provider had a hiccup; the agent is waiting it out and will continue on its own';
  }
}
