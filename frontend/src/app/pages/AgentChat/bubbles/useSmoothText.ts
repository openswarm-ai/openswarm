import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
 * Render model (v2): the v1 hook setState'd every frame, which re-rendered the
 * whole bubble and re-parsed the full markdown tree 60x/s for the entire stream.
 * Now the 60fps motion comes from appending the pending characters straight into
 * the LAST DOM TEXT NODE under `revealRef` (one block relayout, no React), and
 * React only re-renders ("commits") when structure can change: every COMMIT_MS,
 * or immediately when the pending slice contains a newline (new block / list item
 * / fence line). Inline markers (** ` _) show raw for at most COMMIT_MS before
 * the parse formats them, which matches how unclosed markers already looked.
 */

const TARGET_LAG_S = 0.35;   // stay this far behind = the buffer that prevents stalls
const RATE_SMOOTH_S = 0.25;  // how fast the reveal speed eases toward its target
const MAX_CPS = 1000;        // cap so a huge paste/burst still reveals smoothly, not instantly
const MAX_DT_S = 0.05;       // clamp elapsed after a frame drop / tab switch so we don't leap
const COMMIT_MS = 150;       // max staleness of the parsed markdown vs the revealed chars

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

  // Imperative-tail bookkeeping: which committedLen the DOM reflects, and the text node + its committed baseline that per-frame appends write into.
  const domLenRef = useRef<number>(committedLen);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<((now: number) => void) | null>(null);
  const nodeRef = useRef<Text | null>(null);
  const baseRef = useRef<string>('');

  const findLastTextNode = (): Text | null => {
    const root = revealRef.current;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    let n: Node | null;
    while ((n = walker.nextNode())) last = n as Text;
    return last;
  };

  // After each committed render, re-anchor the tail on the fresh DOM and re-apply any chars the reveal position is already past, so a commit never rewinds visible text.
  useLayoutEffect(() => {
    if (!enabled) return;
    const node = findLastTextNode();
    nodeRef.current = node;
    baseRef.current = node ? node.data : '';
    domLenRef.current = committedLen;
    const shown = Math.floor(posRef.current);
    if (node && shown > committedLen) {
      node.data = baseRef.current + targetRef.current.slice(committedLen, shown);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedLen, enabled]);

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
      const desired = backlog / TARGET_LAG_S;            // speed that holds the lag steady (0 when caught up)
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
        if (pending.includes('\n') || due || nodeRef.current === null) {
          committedRef.current = shown;
          lastCommitAtRef.current = now;
          setCommittedLen(shown);
        } else if (domLenRef.current === committed) {
          // DOM is in sync with the last commit; safe to append imperatively.
          nodeRef.current.data = baseRef.current + pending;
        }
        // else: a commit is mid-flight; skip this frame's append (≤1 frame).
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
      lastRef.current = 0;
      committedRef.current = enabled ? 0 : target.length;
      nodeRef.current = null;
      setCommittedLen(enabled ? 0 : target.length);
    }
  }, [target.length, enabled]);

  if (!enabled) return { text: target, revealRef };
  return { text: target.slice(0, committedLen), revealRef };
}
