// D3: the personalize consent. The line reveals word-by-word (smooth, layout-stable, no jumpy
// caret), then a single Yes. "Yes" authorizes the (later) background profiling read; copy says so.

import React, { useEffect, useMemo, useState } from 'react';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';
import { useOnboardingSkin } from '../onboardingSkin';
import { PrimaryButton, GhostLink } from '../OnboardingAtoms';

const LINE =
  "Want me to actually get you? Say yes and I'll take a quick look at whatever you connect, so everything I show is aimed at your world, not a generic demo.";

const WORD_STAGGER_S = 0.055;
const WORD_DUR_S = 0.5;

export const PersonalizeConsent: React.FC<{ onConsent: (yes: boolean) => void }> = ({ onConsent }) => {
  const reduce = useReducedMotion();
  const S = useOnboardingSkin();
  const words = useMemo(() => LINE.split(' '), []);
  const [done, setDone] = useState(reduce);

  useEffect(() => {
    if (reduce) { setDone(true); return; }
    setDone(false);
    const totalMs = (words.length * WORD_STAGGER_S + WORD_DUR_S) * 1000;
    const t = window.setTimeout(() => setDone(true), totalMs);
    return () => window.clearTimeout(t);
  }, [reduce, words.length]);

  return (
    <>
      <div style={{ fontFamily: S.serif, fontWeight: 500, fontSize: 29, lineHeight: 1.4, maxWidth: 620, color: S.text }}>
        {words.map((w, i) => (
          <React.Fragment key={i}>
            <span
              style={{
                display: 'inline-block',
                opacity: reduce ? 1 : 0,
                animation: reduce ? undefined : `onboardingWordIn ${WORD_DUR_S}s cubic-bezier(0.16,1,0.3,1) forwards`,
                animationDelay: reduce ? undefined : `${i * WORD_STAGGER_S}s`,
              }}
            >
              {w}
            </span>
            {i < words.length - 1 ? ' ' : ''}
          </React.Fragment>
        ))}
      </div>
      <div
        style={{
          marginTop: 34,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
          opacity: done ? 1 : 0,
          transition: 'opacity .6s ease',
          pointerEvents: done ? 'auto' : 'none',
        }}
      >
        <PrimaryButton onClick={() => onConsent(true)}>Yes, get to know me</PrimaryButton>
        <GhostLink style={{ marginTop: 2 }} onClick={() => onConsent(false)}>not now</GhostLink>
      </div>
      <style>{'@keyframes onboardingWordIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'}</style>
    </>
  );
};
