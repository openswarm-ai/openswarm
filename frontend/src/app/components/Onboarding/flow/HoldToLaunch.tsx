// Press-and-hold to launch, ported from the glowup CommitmentView. Holding fills a progress ring
// AND grows a warm radial bloom from the button until it covers the screen, then hands off (a clean
// "commit -> go" transition into the running agent). Release early and it shrinks back.
// Reduced motion: a plain button, no bloom, instant.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';
import { useOnboardingSkin } from './onboardingSkin';

const HOLD_MS = 1100;

export const HoldToLaunch: React.FC<{ label: string; onLaunch: () => void }> = ({ label, onLaunch }) => {
  const S = useOnboardingSkin();
  const reduce = useReducedMotion();
  const btnRef = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const [progress, setProgress] = useState(0);
  const [committed, setCommitted] = useState(false);
  const [origin, setOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const commit = useCallback(() => {
    stop();
    setCommitted(true);
    // Let the bloom cover the screen (600ms) before handing off.
    window.setTimeout(onLaunch, 600);
  }, [stop, onLaunch]);

  const tick = useCallback(() => {
    const p = Math.min(1, (performance.now() - startRef.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) { commit(); return; }
    rafRef.current = requestAnimationFrame(tick);
  }, [commit]);

  const begin = useCallback(() => {
    if (committed) return;
    if (reduce) { commit(); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    startRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [committed, reduce, commit, tick]);

  const cancel = useCallback(() => {
    if (committed) return;
    stop();
    setProgress(0);
  }, [committed, stop]);

  useEffect(() => () => stop(), [stop]);

  // Bloom radius: covers the screen from the button center once committed.
  const maxR = Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y),
  ) * 1.25;
  const bloomR = committed ? maxR : progress * maxR;

  return (
    <>
      {/* Warm bloom growing from the button center; ignores pointer so the hold isn't interrupted. */}
      {(progress > 0 || committed) && (
        <div
          style={{
            position: 'fixed',
            left: origin.x - bloomR,
            top: origin.y - bloomR,
            width: bloomR * 2,
            height: bloomR * 2,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${S.accent} 0%, ${S.accent} 40%, transparent 72%)`,
            opacity: committed ? 1 : 0.9,
            pointerEvents: 'none',
            transition: committed ? 'width .6s ease, height .6s ease, left .6s ease, top .6s ease, opacity .6s ease' : 'none',
            zIndex: 1,
          }}
        />
      )}
      <button
        ref={btnRef}
        onPointerDown={begin}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        style={{
          position: 'relative',
          zIndex: 2,
          background: progress > 0.02 ? S.accent : S.ctaBg,
          color: progress > 0.02 ? '#fff' : S.ctaText,
          border: 'none',
          borderRadius: 9,
          padding: '8px 18px',
          fontFamily: S.sans,
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          touchAction: 'none',
          overflow: 'hidden',
        }}
      >
        {/* fill sweeps left->right as you hold */}
        <span
          style={{
            position: 'absolute',
            inset: 0,
            background: S.accent,
            transform: `scaleX(${progress})`,
            transformOrigin: 'left',
            opacity: 0.35,
            pointerEvents: 'none',
          }}
        />
        <span style={{ position: 'relative' }}>{progress > 0.02 ? 'Hold…' : label}</span>
      </button>
    </>
  );
};
