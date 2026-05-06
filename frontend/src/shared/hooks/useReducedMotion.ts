import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  // Modern + legacy event names both supported.
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * True when the OS-level "Reduce motion" preference is on.
 * Mac: System Settings → Accessibility → Display → Reduce Motion.
 * Windows: Settings → Ease of Access → Display → Show animations.
 *
 * Reactive — flips immediately if the user toggles the OS setting
 * mid-session (rare but supported).
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Convenience: returns 0 when reduced-motion is on, otherwise the supplied
 * duration. Use inline at animation sites:
 *
 *   const dur = useMotionDuration(DURATION_MS.quick);
 *   <Fade timeout={dur}>...</Fade>
 *
 * For animations that convey causality (modal open, drawer slide), prefer a
 * tiny non-zero floor so the user still perceives the transition:
 *
 *   const dur = useMotionDuration(DURATION_MS.standard, { floor: 40 });
 */
export function useMotionDuration(ms: number, opts: { floor?: number } = {}): number {
  const reduced = useReducedMotion();
  if (!reduced) return ms;
  return opts.floor ?? 0;
}
