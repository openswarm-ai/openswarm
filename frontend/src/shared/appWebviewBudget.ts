/**
 * Hard ceiling on simultaneously-live app (View) webviews. An app preview is the heaviest surface on
 * the canvas (a full renderer running a live frontend), and unlike browser cards these had NO global
 * cap, so a pile of big app cards left in view could stack renderers until the whole app OOMs. This is
 * admission control: a passive on-screen app goes live only if a slot is free, else it stays a
 * placeholder; the cards closest to the viewport center win the scarce slots. A card the user is
 * actively using (selected, interacting, agent-driven, tiled, fullscreen) is "pinned" and bypasses the
 * cap, the same way a browser card's mustStayLive rule exempts it. Below the cap this is a no-op, so
 * everyday behavior is unchanged; it only bites when too many previews want to be live at once.
 */
export const MAX_LIVE_APP_WEBVIEWS = 6;

// The GLOBAL ceiling across every guest renderer, browsers and apps together. Each side already had
// its own cap (browsers 8, apps 6) but neither knew the other existed, so a busy canvas could still
// stack 14 live renderers, and renderer memory pressure is exactly what evicts the wash (the
// background band) and, at the limit, what OOMs the app. Pinned/working cards stay exempt: a
// throttle must never blind an agent mid-task.
export const MAX_LIVE_GUESTS = 10;

// Browsers live in redux, not in this map; the suspend hook wires in a counter so this module stays
// store-free (and its tests stay pure).
let p_browserLiveCount: () => number = () => 0;

export function wireBrowserLiveCounter(fn: () => number): void {
  p_browserLiveCount = fn;
}

export function totalLiveGuests(): number {
  return live.size + p_browserLiveCount();
}

export function guestBudgetHasRoom(): boolean {
  return totalLiveGuests() < MAX_LIVE_GUESTS;
}

interface Slot {
  priority: number; // squared distance from viewport center; smaller = closer = kept when slots are scarce
  pinned: boolean; // actively used: never counted against the cap, never evicted
}

const live = new Map<string, Slot>();
const listeners = new Set<() => void>();
// Anti-flap (the 2+ min zoom-out park/unpark storm): priorities are squared distances recomputed
// per tick, so near-equal cards stole the slot back and forth as the camera drifted, rebooting a
// webview on every steal. An eviction now needs BOTH a meaningfully closer challenger and a slot
// old enough to have been worth booting.
const grantedAt = new Map<string, number>();
export const EVICT_COOLDOWN_MS = 10_000;
export const EVICT_MARGIN = 0.8;

// Deferred: an eviction firing inside one card's render must not synchronously poke another card's state.
function notify(): void {
  queueMicrotask(() => {
    for (const fn of [...listeners]) fn();
  });
}

function evictableLiveCount(): number {
  let n = 0;
  for (const s of live.values()) if (!s.pinned) n++;
  return n;
}

/**
 * Whether this card may be live now. Idempotent (safe to call every pan/resize tick). A pinned card is
 * always granted; an unpinned one is granted if a slot is free, or if it is closer to center than the
 * farthest currently-live unpinned card, which it then evicts.
 */
export function requestAppSlot(key: string, priority: number, pinned: boolean): boolean {
  const existing = live.get(key);
  if (existing) {
    existing.priority = priority;
    existing.pinned = pinned;
    return true;
  }
  if (pinned || (evictableLiveCount() < MAX_LIVE_APP_WEBVIEWS && guestBudgetHasRoom())) {
    live.set(key, { priority, pinned });
    grantedAt.set(key, Date.now());
    return true;
  }
  let worstKey: string | null = null;
  let worstPriority = -Infinity;
  const now = Date.now();
  for (const [k, s] of live) {
    if (s.pinned) continue;
    if (now - (grantedAt.get(k) ?? 0) < EVICT_COOLDOWN_MS) continue;
    if (s.priority > worstPriority) {
      worstPriority = s.priority;
      worstKey = k;
    }
  }
  if (worstKey !== null && priority < worstPriority * EVICT_MARGIN) {
    live.delete(worstKey);
    grantedAt.delete(worstKey);
    live.set(key, { priority, pinned });
    grantedAt.set(key, now);
    notify(); // the evicted card must re-evaluate and drop to a placeholder
    return true;
  }
  return false;
}

/** A card that suspends or unmounts MUST release, or its slot leaks and a capped card never wakes. */
export function releaseAppSlot(key: string): void {
  grantedAt.delete(key);
  if (live.delete(key)) notify(); // a freed slot lets a capped card come alive
}

/** Re-run a card's live/suspend decision whenever the budget changes (an eviction or a freed slot). */
export function subscribeAppBudget(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
