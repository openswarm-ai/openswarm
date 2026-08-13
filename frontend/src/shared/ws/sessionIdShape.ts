// Is this actually one of our session ids? (ENG-205)
//
// A user's console showed `GET /api/agents/sessions/ae8813e9d5d20fb7.1 -> 404` plus a matching
// "WebSocket closed before the connection was established". That id is 16 hex chars with a dotted
// suffix; ours are 32 hex chars with no suffix. Measured across 248 real sessions on a dev machine:
// zero filenames of that shape and zero `sdk_session_id` values containing a dot. Neither the
// frontend nor the backend constructs one, so the value arrives from somewhere as the sessionId and
// nothing on the way to the socket would notice.
//
// The bug is not the 404, it is that nobody can say who produced the id. So the shape check exists
// to make the next occurrence name its own producer instead of costing another round of guessing.

/** Our session ids: 32 lowercase hex characters, nothing else. */
const P_CANONICAL = /^[0-9a-f]{32}$/;

export function isCanonicalSessionId(id: string): boolean {
  return P_CANONICAL.test(id);
}

/**
 * Warn once per offending id, with a stack, when something asks us to open a socket for an id we
 * could never have issued. Deliberately does NOT refuse: 248 sessions on one machine is not enough
 * evidence to start dropping connections, and a diagnostic that changes behaviour is a second bug.
 */
const p_warned = new Set<string>();

export function warnIfNotCanonicalSessionId(id: string, where: string): boolean {
  if (isCanonicalSessionId(id)) return true;
  if (p_warned.has(id)) return false;
  p_warned.add(id);
  // eslint-disable-next-line no-console
  console.warn(
    `[ENG-205] ${where} received a session id we never issue: ${JSON.stringify(id)} `
    + `(expected 32 hex chars). The 404 and the WS close that follow are consequences, not the bug. `
    + `Stack names the producer:`,
    new Error('session-id origin').stack,
  );
  return false;
}

export function resetSessionIdWarnings(): void {
  p_warned.clear();
}
