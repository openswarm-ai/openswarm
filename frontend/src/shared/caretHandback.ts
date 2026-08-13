// When should the user's caret be handed back? (ENG-252, 5th filing)
//
// The restore itself has existed since ENG-226 and works. Traced from control flow: the socket
// delivers ONE command per message, and `handleBrowserCommand` brackets each one with
// capture/restore, while every keyboard primitive inside takes host focus. So an agent run of N
// commands is literally steal, restore, steal, restore, N times. Every command behaves correctly
// and the caret is unusable, which is why four fixes "passed" and the user kept reopening it.
//
// The defect is the FREQUENCY, so the fix is fewer handbacks, not better ones: coalesce them, and
// give the caret back once the agent has actually stopped touching the browser.
//
// Deliberately NOT the more aggressive option (agent owns the caret for a whole run, user cannot
// type at all until it finishes). That is a product judgement about a resource measured to be
// singular, and it belongs to a human. This keeps the existing end state and only removes the
// thrash, so it cannot make the current behaviour worse.

export const HANDBACK_IDLE_MS = 400;

interface Pending {
  restore: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let p_pending: Pending | null = null;
let p_handbacks = 0;

/** How many times the caret was actually handed back. The number ENG-252 is about. */
export function caretHandbackCount(): number {
  return p_handbacks;
}

export function resetCaretHandbackCount(): void {
  p_handbacks = 0;
}

/**
 * Schedule the caret handback, superseding any already-pending one.
 *
 * Called at the end of every browser command. A run of back-to-back commands therefore schedules N
 * times and hands back ONCE, after the agent goes quiet for HANDBACK_IDLE_MS. The restore closure
 * is the newest one, so it reflects the most recent capture rather than a stale element.
 */
export function scheduleCaretHandback(
  restore: () => void,
  idleMs: number = HANDBACK_IDLE_MS,
  setTimer: typeof setTimeout = setTimeout,
  clearTimer: typeof clearTimeout = clearTimeout,
): void {
  if (p_pending) clearTimer(p_pending.timer);
  const timer = setTimer(() => {
    p_pending = null;
    p_handbacks += 1;
    restore();
  }, idleMs);
  p_pending = { restore, timer };
}

/** Drop any pending handback without running it, for teardown. */
export function cancelCaretHandback(clearTimer: typeof clearTimeout = clearTimeout): void {
  if (!p_pending) return;
  clearTimer(p_pending.timer);
  p_pending = null;
}

export function caretHandbackPending(): boolean {
  return p_pending !== null;
}
