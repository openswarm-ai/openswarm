// Escalate a failed cached-index click to a fresh by-name resolution only when it's
// safe and possible: the click explicitly ERRORED (so it provably never landed, no
// double-act risk), it wasn't a text-fill (fills verify themselves), we know the
// element's name to re-find it, and the A/B toggle is on. Pure so the invariant is testable.
export function shouldSelfHealClick(
  errored: boolean, wantsText: boolean, name: string | undefined, selfheal: unknown,
): boolean {
  return errored && !wantsText && !!name && selfheal !== false;
}
