// Which collapsed chats currently have a LIVE surface miniature tucked under the pill.
//
// Surfaces are browsers AND apps. It was browser-only, and an app tucking under a pill therefore
// never announced itself, so the pill happily drew its steps popover straight over the app
// (ENG-410). The map is keyed by parent session and holds the surface id, so two surfaces under one
// pill cannot silently un-register each other.
// The pill reads this to go quiet (no widget/shot/thinking below it) so nothing overlaps the
// miniature; render-level only, so the park machinery's state is never touched (the earlier
// drop-the-frozen-shot approach made park/unpark oscillate and the browser blinked).
const p_following = new Map<string, string>();
const p_subs = new Set<() => void>();

export function subscribeFollowingBrowsers(fn: () => void): () => void {
  p_subs.add(fn);
  return () => p_subs.delete(fn);
}

export function setSurfaceFollowing(parentSessionId: string, surfaceId: string, on: boolean): void {
  const cur = p_following.get(parentSessionId);
  if (on) {
    if (cur === surfaceId) return;
    p_following.set(parentSessionId, surfaceId);
  } else {
    if (cur !== surfaceId) return;
    p_following.delete(parentSessionId);
  }
  p_subs.forEach((fn) => fn());
}

export function isSurfaceFollowing(parentSessionId: string): boolean {
  return p_following.has(parentSessionId);
}

/** @deprecated browser-only name kept so no call site silently stops registering. */
export const setBrowserFollowing = setSurfaceFollowing;
export const isBrowserFollowing = isSurfaceFollowing;
