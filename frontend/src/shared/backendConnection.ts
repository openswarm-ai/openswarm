// One source of truth for "is our local backend answering", fed by the global fetch
// interceptor (config.ts) and consumed by the reconnecting pill. Exists so an unreachable
// backend can never again present as a silent forever-spinner (ENG-241/ENG-242): every
// consumer reads the same signal, and a background probe self-heals the moment it returns.

type ReachabilityListener = (reachable: boolean) => void;

let reachableNow = true;
let failStreak = 0;
const listeners = new Set<ReachabilityListener>();
let probeTimer: ReturnType<typeof setInterval> | null = null;
// Injected by config.ts with the UN-intercepted fetch so probes never recurse into retry logic.
let prober: (() => Promise<unknown>) | null = null;

export function backendReachable(): boolean {
  return reachableNow;
}

export function onBackendReachability(cb: ReachabilityListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function setBackendProber(fn: () => Promise<unknown>): void {
  prober = fn;
}

function emit(value: boolean): void {
  listeners.forEach((l) => { try { l(value); } catch { /* a listener must never break the signal */ } });
}

function startProbe(): void {
  if (probeTimer || !prober) return;
  probeTimer = setInterval(() => {
    void (prober as () => Promise<unknown>)()
      .then(() => noteBackendSuccess())
      .catch(() => { /* still down; keep probing */ });
  }, 1500);
}

function stopProbe(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

export function noteBackendFailure(): void {
  failStreak++;
  // Two consecutive failures = down. One lone failure is never a state flip, so a single
  // dropped request can't flash the reconnecting UI.
  if (reachableNow && failStreak >= 2) {
    reachableNow = false;
    emit(false);
    startProbe();
  }
}

export function noteBackendSuccess(): void {
  failStreak = 0;
  if (!reachableNow) {
    reachableNow = true;
    stopProbe();
    emit(true);
  }
}

// A request that STALLS (a squatted or wedged port accepts the connection and never answers) would
// otherwise take the full attempt timeout before counting as a failure, leaving the user staring at
// a spinner for ~25s+ with the signal still green. The stall watchdog asks the prober directly, so
// "is the backend actually alive" is answered in seconds regardless of how long the request hangs.
export function probeNow(): void {
  if (!prober) return;
  void prober().then(() => noteBackendSuccess()).catch(() => noteBackendFailure());
}

export function noteRequestStalled(): void {
  if (!reachableNow) return;
  probeNow();
  // Two probe failures are what flips the signal, matching the normal path; a backend that answers
  // either probe is simply slow, not down, and nothing is shown.
  setTimeout(() => { if (reachableNow) probeNow(); }, 1200);
}

// Harness/debug handle: lets a live session (CDP, support) read the signal without a store import.
// Guarded: reducers that import this module also run under node:test, where there is no window.
if (typeof window !== 'undefined') {
  (window as unknown as { __OSW_CONN?: object }).__OSW_CONN = { backendReachable, onBackendReachability };
}
