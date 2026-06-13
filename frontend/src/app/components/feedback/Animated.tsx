import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import { DURATION_MS, EASE } from '@/shared/styles/motionTokens';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';

/**
 * Smooth visual transitions for status pills + counters that currently snap.
 *
 *   <CrossFadeOnChange value={x}>{(v) => <span>{v}</span>}</CrossFadeOnChange>
 *     Old value fades to 30% while new value fades in. Cancels on rapid changes.
 *
 *   <TweeningNumber value={1234} format={(n) => `$${n.toFixed(4)}`} />
 *     RAF-tweens from previous to new value. Caps duration on big jumps.
 */

interface CrossFadeProps<T> {
  value: T;
  children: (currentValue: T) => React.ReactNode;
  /** Defaults to DURATION_MS.quick (140ms). */
  durationMs?: number;
}

export function CrossFadeOnChange<T>({ value, children, durationMs }: CrossFadeProps<T>) {
  const reduced = useReducedMotion();
  const dur = reduced ? 0 : (durationMs ?? DURATION_MS.quick);
  const [displayed, setDisplayed] = useState(value);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    if (Object.is(displayed, value)) return;
    if (dur === 0) {
      setDisplayed(value);
      return;
    }
    // Fade old to ~0, then swap and fade new in.
    setOpacity(0);
    const t = setTimeout(() => {
      setDisplayed(value);
      setOpacity(1);
    }, dur / 2);
    return () => clearTimeout(t);
  }, [value, dur, displayed]);

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        opacity,
        transition: `opacity ${dur / 2}ms ${EASE.out}`,
      }}
    >
      {children(displayed)}
    </Box>
  );
}

interface TypewriterProps {
  value: string;
  children: (current: string) => React.ReactNode;
  charDelayMs?: number;
  enabled?: boolean;
  snapOnFirstTransition?: boolean;
}

export function Typewriter({ value, children, charDelayMs = 14, enabled = true, snapOnFirstTransition = false }: TypewriterProps) {
  const reduced = useReducedMotion();
  const [displayed, setDisplayed] = useState(value);
  const targetRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasTransitionedRef = useRef(false);

  useEffect(() => {
    targetRef.current = value;
    if (!enabled || reduced) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setDisplayed(value);
      if (value !== displayed) hasTransitionedRef.current = true;
      return;
    }
    if (value === displayed) return;
    if (snapOnFirstTransition && !hasTransitionedRef.current) {
      hasTransitionedRef.current = true;
      setDisplayed(value);
      return;
    }
    hasTransitionedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    const tick = () => {
      setDisplayed((prev) => {
        const target = targetRef.current;
        if (prev === target) return prev;
        let commonLen = 0;
        while (commonLen < prev.length && commonLen < target.length && prev[commonLen] === target[commonLen]) {
          commonLen++;
        }
        const next = prev.length > commonLen
          ? prev.substring(0, prev.length - 1)
          : target.substring(0, prev.length + 1);
        if (next !== target) {
          timerRef.current = setTimeout(tick, charDelayMs);
        }
        return next;
      });
    };
    timerRef.current = setTimeout(tick, charDelayMs);
    return () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [value, enabled, reduced, charDelayMs, snapOnFirstTransition, displayed]);

  return <>{children(displayed)}</>;
}

interface TweeningNumberProps {
  value: number;
  /** How to render the tweened number. Default: `n.toString()`. */
  format?: (n: number) => string;
  /** Cap on tween duration regardless of delta. Default 500ms. */
  maxDurationMs?: number;
}

export const TweeningNumber: React.FC<TweeningNumberProps> = ({
  value,
  format = (n) => String(Math.round(n)),
  maxDurationMs = 500,
}) => {
  const reduced = useReducedMotion();
  const [displayed, setDisplayed] = useState(value);
  const startedAtRef = useRef<number | null>(null);
  const fromRef = useRef<number>(value);
  const toRef = useRef<number>(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setDisplayed(value);
      return;
    }
    if (Object.is(toRef.current, value)) return;

    fromRef.current = displayed;
    toRef.current = value;
    startedAtRef.current = performance.now();

    // Duration scales with delta but caps. ~1ms per unit, capped.
    const delta = Math.abs(value - fromRef.current);
    const dur = Math.min(maxDurationMs, Math.max(120, delta * 1.2));

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const step = (now: number) => {
      const t = Math.min(1, (now - (startedAtRef.current as number)) / dur);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = fromRef.current + (toRef.current - fromRef.current) * eased;
      setDisplayed(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, reduced, maxDurationMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return <>{format(displayed)}</>;
};
