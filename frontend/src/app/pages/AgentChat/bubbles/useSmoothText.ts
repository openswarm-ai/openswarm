import { useEffect, useRef, useState } from 'react';

/**
 * Smoothly reveals streamed text at a steady cadence instead of painting bursty
 * network chunks as they land. Decouples DISPLAY rate from ARRIVAL rate the way
 * claude.ai does, so generated text reads like it's being typed rather than
 * dumped in clumps.
 *
 * Velocity model (unchanged from v1): a buffered constant-velocity controller.
 *   - It deliberately stays ~TARGET_LAG seconds BEHIND the latest text, so there
 *     is always a buffer to reveal and it never runs dry between tokens.
 *   - Reveal is TIME-based (chars = rate * elapsed), so it's frame-rate
 *     independent and survives a dropped frame without a visible jump.
 *   - The reveal RATE is EMA-smoothed, so a burst ramps the speed up gently and
 *     a lull ramps it down gently; the rate never steps, so the flow never pulses.
 *
 * Render model (v3): REACT OWNS THE TEXT, and nothing else may write it.
 *
 * v2 painted the 60fps motion by appending straight into the last DOM text node under `revealRef`,
 * with React committing only every COMMIT_MS. Two writers for one string, and it corrupted output in
 * the field: users pasted back answers containing the same sentence twice at different offsets,
 * clipped at both ends ("recallsByVehicle" arriving again as "ecallsByVehicle"), plus raw markdown
 * leaking through where rendered text belonged.
 *
 * The reason it cannot be made safe with a guard: React reconciles a text node against ITS OWN
 * previous value, not against the live DOM. Mutate that node behind React's back and, whenever
 * React's before/after values happen to match, it skips the update and the injected characters
 * survive forever. Drilled in a real Chromium DOM 2026-08-27 -- an anchor-freshness check still
 * corrupted 5 of 6 runs, because the damage is done by the time any check could notice.
 *
 * So the reveal advances only on commits: every COMMIT_MS, or immediately when the pending slice
 * contains a newline (new block / list item / fence line). hermes-agent renders streamed text with
 * a memoised parse and a blinking caret and no pacing at all, which is the same conclusion one step
 * further; keeping the velocity model preserves the typed feel this was built for.
 */

// The lag is the buffer that prevents stalls, so it has to be at least one arrival interval: the
// CLI hands us text in ~90-char lumps every ~580 ms (measured 2026-09-03 at the SDK boundary, while
// the router underneath streamed every 30-90 ms), and a fixed 0.35 s drained each lump and then sat
// idle for the rest of the gap, which read as burst, pause, burst. Fine-grained lanes keep the floor.
const LAG_MIN_S = 0.3;
const LAG_MAX_S = 0.9;
const LAG_GAP_RATIO = 1.25;
const GAP_EMA = 0.3;

export function lagForGap(gapEmaS: number | null): number {
  if (gapEmaS == null || !Number.isFinite(gapEmaS) || gapEmaS <= 0) return LAG_MIN_S;
  return Math.min(LAG_MAX_S, Math.max(LAG_MIN_S, gapEmaS * LAG_GAP_RATIO));
}

/** EMA of the interval between text arrivals; the first arrival seeds it. */
export function nextGapEma(prev: number | null, gapS: number): number {
  if (prev == null) return gapS;
  return prev + (gapS - prev) * GAP_EMA;
}
const RATE_SMOOTH_S = 0.25;  // how fast the reveal speed eases toward its target
const MAX_CPS = 1000;        // cap so a huge paste/burst still reveals smoothly, not instantly
const MAX_DT_S = 0.05;       // clamp elapsed after a frame drop / tab switch so we don't leap
// Every frame. At 60 ms the eye got 12 characters every 67 ms, which reads as words popping (Eric:
// "chunky"); at 16 ms it gets 3 per frame. Measured 2026-09-03 on a 9,000-char reply: frame time
// p50/p90/p99 17/17/18 ms in both arms, 8 vs 2 frames over 25 ms across 49 s, so a commit per frame is free.
const COMMIT_MS = 16;

export function useSmoothText(
  target: string,
  enabled: boolean,
): { text: string; revealRef: React.RefObject<HTMLElement | null> } {
  const [committedLen, setCommittedLen] = useState(enabled ? 0 : target.length);
  const revealRef = useRef<HTMLElement | null>(null);

  const targetRef = useRef(target);
  targetRef.current = target;

  // Controller state lives in refs so the rAF loop reads the latest without the effect re-subscribing every character.
  const posRef = useRef<number>(enabled ? 0 : target.length); // float reveal position
  const cpsRef = useRef<number>(0);                            // current reveal speed
  const lastRef = useRef<number>(0);                           // last frame timestamp
  const committedRef = useRef<number>(committedLen);
  const lastCommitAtRef = useRef<number>(0);
  const lastArrivalRef = useRef<number>(0);
  const gapEmaRef = useRef<number | null>(null);

  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<((now: number) => void) | null>(null);

  // ONE persistent loop, keyed only on `enabled`. It must NOT restart per token: an effect that depends on target.length tears the rAF down and rebuilds it on every delta, and that churn is what stalls the reveal.
  useEffect(() => {
    if (!enabled) {
      posRef.current = targetRef.current.length;
      committedRef.current = targetRef.current.length;
      setCommittedLen(targetRef.current.length);
      return;
    }

    const tick = (now: number) => {
      const full = targetRef.current.length;
      const dtRaw = lastRef.current ? (now - lastRef.current) / 1000 : 0.016;
      lastRef.current = now;
      const dt = dtRaw > MAX_DT_S ? MAX_DT_S : dtRaw;

      const backlog = Math.max(0, full - posRef.current);
      const desired = backlog / lagForGap(gapEmaRef.current); // speed that holds the lag steady (0 when caught up)
      const k = Math.min(1, dt / RATE_SMOOTH_S);
      let cps = cpsRef.current + (desired - cpsRef.current) * k; // EMA-smooth the speed itself, both up and down
      if (cps > MAX_CPS) cps = MAX_CPS;
      if (cps < 0) cps = 0;
      cpsRef.current = cps;

      if (backlog > 0) {
        posRef.current = Math.min(full, posRef.current + cps * dt);
      }
      const shown = Math.floor(posRef.current);
      const committed = committedRef.current;
      if (shown > committed) {
        const pending = targetRef.current.slice(committed, shown);
        const due = now - lastCommitAtRef.current >= COMMIT_MS;
        if (pending.includes('\n') || due) {
          committedRef.current = shown;
          lastCommitAtRef.current = now;
          setCommittedLen(shown);
        }
      }
      // Fully revealed AND fully committed: park instead of burning 60fps forever; the growth effect below re-arms.
      if (posRef.current >= full && committedRef.current >= full) {
        rafRef.current = null;
        lastRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    tickRef.current = tick;
    lastRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [enabled]);

  // Re-arm a parked loop when new text lands. This never tears the running loop down (the churn the
  // persistent-loop comment above warns about); it only restarts one that parked itself at idle.
  useEffect(() => {
    if (!enabled) return;
    // Every growth is an arrival; the interval between them sizes the lag above.
    const now = performance.now();
    if (lastArrivalRef.current) gapEmaRef.current = nextGapEma(gapEmaRef.current, (now - lastArrivalRef.current) / 1000);
    lastArrivalRef.current = now;
    if (rafRef.current === null && tickRef.current && posRef.current < target.length) {
      lastRef.current = 0;
      rafRef.current = requestAnimationFrame(tickRef.current);
    }
  }, [target.length, enabled]);

  // Target shrank (new turn / reset / branch switch): re-sync so we don't slice past the end of a shorter string and so a fresh turn starts from zero.
  useEffect(() => {
    if (posRef.current > target.length) {
      posRef.current = enabled ? 0 : target.length;
      cpsRef.current = 0;
      lastArrivalRef.current = 0;
      gapEmaRef.current = null;
      lastRef.current = 0;
      committedRef.current = enabled ? 0 : target.length;
      setCommittedLen(enabled ? 0 : target.length);
    }
  }, [target.length, enabled]);

  if (!enabled) return { text: target, revealRef };
  return { text: target.slice(0, committedLen), revealRef };
}
