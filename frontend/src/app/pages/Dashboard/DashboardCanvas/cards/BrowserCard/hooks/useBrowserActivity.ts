import { useState, useEffect, useRef, useCallback } from 'react';
import {
  subscribeActivity,
  getActivity,
  type BrowserActivity,
  type BrowserAction,
} from '@/shared/browsers/browserCommandHandler/browserCommandTypes';

interface BrowserActivityState {
  active: boolean;
  action: BrowserAction | null;
  detail: string | null;
  /** The action that just completed — stays set briefly for exit animations */
  lastAction: BrowserAction | null;
  /** Increments on each new action — use as React key to restart CSS animations */
  actionSeq: number;
  /** Viewport-relative click coordinates (0-1 range) for positioning the click ripple */
  coords: { xPercent: number; yPercent: number } | null;
}

const EMPTY: BrowserActivityState = { active: false, action: null, detail: null, lastAction: null, actionSeq: 0, coords: null };

export function useBrowserActivity(browserId: string): BrowserActivityState {
  const [state, setState] = useState<BrowserActivityState>(() => {
    const current = getActivity(browserId);
    return current
      ? { active: true, action: current.action, detail: current.detail ?? null, lastAction: null, actionSeq: 0, coords: current.coords ?? null }
      : EMPTY;
  });

  const lastActionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (changedId: string, activity: BrowserActivity | null) => {
      if (changedId !== browserId) return;
      if (activity) {
        if (lastActionTimer.current) clearTimeout(lastActionTimer.current);
        setState((prev) => ({
          active: true,
          action: activity.action,
          detail: activity.detail ?? null,
          lastAction: null,
          actionSeq: prev.actionSeq + 1,
          coords: activity.coords ?? prev.coords,
        }));
      } else {
        setState((prev) => ({
          active: false,
          action: null,
          detail: null,
          lastAction: prev.action,
          actionSeq: prev.actionSeq,
          coords: prev.coords,
        }));
        lastActionTimer.current = setTimeout(() => {
          setState((prev) => (prev.active ? prev : { ...prev, lastAction: null, coords: null }));
        }, 600);
      }
    },
    [browserId],
  );

  useEffect(() => {
    return subscribeActivity(handleChange);
  }, [handleChange]);

  useEffect(() => {
    return () => {
      if (lastActionTimer.current) clearTimeout(lastActionTimer.current);
    };
  }, []);

  return state;
}
