// Mounts a single global listener that records each user interaction
// timestamp into Redux. One installer per app — call from Main.tsx after
// the store is provided.
//
// Debounces at 1-second granularity so we don't spam Redux on every
// keystroke. Coarse enough for "idle dim after N minutes" UX; fine enough
// that the timestamp on session close is accurate to the second.

import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { interactionRecorded } from '@/shared/state/interactionSlice';

const DEBOUNCE_MS = 1000;

export function useInteractionHeartbeat(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let lastDispatched = 0;

    const onInteract = () => {
      const now = Date.now();
      if (now - lastDispatched < DEBOUNCE_MS) return;
      lastDispatched = now;
      dispatch(interactionRecorded({ at: now }));
    };

    const opts: AddEventListenerOptions = { passive: true, capture: true };
    window.addEventListener('keydown', onInteract, opts);
    window.addEventListener('mousedown', onInteract, opts);
    window.addEventListener('scroll', onInteract, opts);
    window.addEventListener('wheel', onInteract, opts);
    window.addEventListener('touchstart', onInteract, opts);

    return () => {
      window.removeEventListener('keydown', onInteract, opts);
      window.removeEventListener('mousedown', onInteract, opts);
      window.removeEventListener('scroll', onInteract, opts);
      window.removeEventListener('wheel', onInteract, opts);
      window.removeEventListener('touchstart', onInteract, opts);
    };
  }, [dispatch]);
}
