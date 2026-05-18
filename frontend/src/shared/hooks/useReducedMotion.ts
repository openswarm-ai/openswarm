import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
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

/** True when the OS "Reduce motion" preference is on; reactive to OS toggles. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Returns 0 (or `opts.floor`) when reduced-motion is on, else `ms`. */
export function useMotionDuration(ms: number, opts: { floor?: number } = {}): number {
  const reduced = useReducedMotion();
  if (!reduced) return ms;
  return opts.floor ?? 0;
}
