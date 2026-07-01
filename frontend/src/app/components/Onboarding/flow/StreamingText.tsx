// Reveals text word-by-word (a gentle rise + fade), so generated lines feel like they stream in the
// way Claude's responses do. Reduced-motion shows it all at once. Shared by the consent + payoff.

import React, { useEffect, useMemo, useState } from 'react';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';

const WORD_STAGGER_S = 0.05;
const WORD_DUR_S = 0.45;

export const StreamingText: React.FC<{
  text: string;
  style?: React.CSSProperties;
  onDone?: () => void;
}> = ({ text, style, onDone }) => {
  const reduce = useReducedMotion();
  const words = useMemo(() => text.split(' '), [text]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDone(false);
    if (reduce) { setDone(true); onDone?.(); return; }
    const totalMs = (words.length * WORD_STAGGER_S + WORD_DUR_S) * 1000;
    const t = window.setTimeout(() => { setDone(true); onDone?.(); }, totalMs);
    return () => window.clearTimeout(t);
    // onDone intentionally excluded: callers pass fresh closures; keying on text is enough.
  }, [text, reduce, words.length]);

  return (
    <span style={style}>
      {words.map((w, i) => (
        <React.Fragment key={i}>
          <span
            style={{
              display: 'inline-block',
              opacity: reduce || done ? 1 : 0,
              animation: reduce ? undefined : `onboardingWordIn ${WORD_DUR_S}s cubic-bezier(0.16,1,0.3,1) forwards`,
              animationDelay: reduce ? undefined : `${i * WORD_STAGGER_S}s`,
            }}
          >
            {w}
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </React.Fragment>
      ))}
      <style>{'@keyframes onboardingWordIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'}</style>
    </span>
  );
};
