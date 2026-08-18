// Which collapsed chats currently have their LIVE browser miniature tucked under the pill.
// The pill reads this to go quiet (no widget/shot/thinking below it) so nothing overlaps the
// miniature; render-level only, so the park machinery's state is never touched (the earlier
// drop-the-frozen-shot approach made park/unpark oscillate and the browser blinked).
const p_following = new Map<string, string>();
const p_subs = new Set<() => void>();

export function subscribeFollowingBrowsers(fn: () => void): () => void {
  p_subs.add(fn);
  return () => p_subs.delete(fn);
}

export function setBrowserFollowing(parentSessionId: string, browserId: string, on: boolean): void {
  const cur = p_following.get(parentSessionId);
  if (on) {
    if (cur === browserId) return;
    p_following.set(parentSessionId, browserId);
  } else {
    if (cur !== browserId) return;
    p_following.delete(parentSessionId);
  }
  p_subs.forEach((fn) => fn());
}

export function isBrowserFollowing(parentSessionId: string): boolean {
  return p_following.has(parentSessionId);
}
