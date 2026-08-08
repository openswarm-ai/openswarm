/**
 * Serialises <webview> attachment so only one is in flight at a time.
 *
 * Electron attaches a guest view with a SYNCHRONOUS renderer IPC (GUEST_VIEW_MANAGER_CALL), so N
 * cards mounting together put N blocking round-trips in one frame. Measured on a real dashboard:
 * opening one with 18 cards / 8 webviews blocked the main thread for 4755ms across 40 long tasks,
 * while an idle canvas blocked for 0ms (ENG-193).
 *
 * The first version released a slot per animation frame, which was not enough: an attach costs
 * 60-140ms, i.e. several frames, so the next slot fired mid-attach and they overlapped anyway
 * (worst single task stayed at 292ms). Slots now wait for the previous card to report it finished,
 * with a ceiling so a card that never reports cannot wedge every card behind it.
 */

type Slot = () => void;

// An attach measured 60-140ms in isolation; this only bounds the pathological case where a card
// mounts and never signals, so it is deliberately far above the real cost.
const P_ATTACH_CEILING_MS = 1200;

let pending: Slot[] = [];
let inFlight = false;
let ceiling: ReturnType<typeof setTimeout> | null = null;

function p_startNext(): void {
  const next = pending.shift();
  if (!next) {
    inFlight = false;
    return;
  }
  inFlight = true;
  if (ceiling) clearTimeout(ceiling);
  ceiling = setTimeout(() => { ceiling = null; p_startNext(); }, P_ATTACH_CEILING_MS);
  try {
    next();
  } catch {
    /* a card that blew up on attach must not stall every card behind it */
    if (ceiling) { clearTimeout(ceiling); ceiling = null; }
    p_startNext();
  }
}

/**
 * Ask for the next attach slot. `onReady` fires immediately if nothing is attaching, otherwise once
 * the card ahead reports done. Returns a cancel function for unmount before the slot arrives.
 */
export function requestWebviewAttachSlot(onReady: Slot): () => void {
  pending.push(onReady);
  if (!inFlight) {
    // Start on the next frame so a burst of cards mounting in one commit all queue up first.
    requestAnimationFrame(() => { if (!inFlight) p_startNext(); });
  }
  return () => {
    pending = pending.filter((s) => s !== onReady);
  };
}

/** A card calls this once its guest has actually attached, releasing the next card in line. */
export function releaseWebviewAttachSlot(): void {
  if (ceiling) { clearTimeout(ceiling); ceiling = null; }
  p_startNext();
}

/** Cards waiting behind the queue right now; exposed so a test can prove the burst is serialised. */
export function pendingAttachCount(): number {
  return pending.length;
}
