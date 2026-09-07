import { useCallback, useRef } from 'react';

// A callback whose IDENTITY never changes while its body always sees the latest closure. For a
// handler handed to every memoized card on the board: a plain useCallback whose deps include the
// selection re-created itself on every send, and 150 AgentCards re-rendered their whole chrome for
// it (a 380 ms commit on a 4x-throttled machine, the ENG-467 send freeze). Only for event handlers:
// the latest body is read at CALL time, never at render time.
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
