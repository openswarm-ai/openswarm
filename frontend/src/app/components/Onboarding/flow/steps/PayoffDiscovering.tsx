// Transition shown while the payoff is being generated (mainly the "just show me" path): a calm
// working animation + one honest rotating line, then it auto-advances when the content is ready.
// Honest by design: the lines describe thinking/pulling-together, never claim to read data it can't.

import React, { useEffect, useState } from 'react';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';
import { useOnboardingSkin } from '../onboardingSkin';

const LINES = [
  'Getting a sense of what would actually help you',
  'Lining up a few things I can just go do',
  'Almost there',
];

// Advance when content is ready, but never flash: hold a minimum beat so it reads as "working".
const MIN_MS = 1400;

export const PayoffDiscovering: React.FC<{ ready: boolean; onDone: () => void }> = ({ ready, onDone }) => {
  const S = useOnboardingSkin();
  const reduce = useReducedMotion();
  const [line, setLine] = useState(0);
  const [minMet, setMinMet] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setMinMet(true), MIN_MS);
    const rot = reduce ? null : window.setInterval(() => setLine((l) => Math.min(l + 1, LINES.length - 1)), 1400);
    return () => { window.clearTimeout(t); if (rot) window.clearInterval(rot); };
  }, [reduce]);

  useEffect(() => { if (ready && minMet) onDone(); }, [ready, minMet, onDone]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
      <div style={{ position: 'relative', width: 40, height: 40 }}>
        <span
          style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            border: `2px solid ${S.border}`, borderTopColor: S.accent,
            animation: reduce ? undefined : 'onboardingSpin 0.9s linear infinite',
          }}
        />
      </div>
      <div style={{ fontFamily: S.serif, fontSize: 20, color: S.text, opacity: 0.9, minHeight: '1.4em', transition: 'opacity .4s ease' }}>
        {LINES[line]}
      </div>
      <style>{'@keyframes onboardingSpin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
};
