// Payoff beat 1: the warm hello, alone. Greeting + an optional quirky remark, then Continue.

import React, { useEffect, useState } from 'react';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';
import { useOnboardingSkin } from '../onboardingSkin';
import { Heading, PrimaryButton } from '../OnboardingAtoms';

export const PayoffHello: React.FC<{ greeting: string; remark?: string; onContinue: () => void }> = ({
  greeting,
  remark,
  onContinue,
}) => {
  const S = useOnboardingSkin();
  const reduce = useReducedMotion();
  // Let the hello land for a beat before the button fades in, so it feels like a moment, not a form.
  const [ready, setReady] = useState(reduce);
  useEffect(() => {
    if (reduce) { setReady(true); return; }
    const t = window.setTimeout(() => setReady(true), 700);
    return () => window.clearTimeout(t);
  }, [reduce]);

  return (
    <>
      <Heading>{greeting}</Heading>
      {remark && <div style={{ marginTop: 12, fontSize: 15, color: S.muted, fontStyle: 'italic' }}>{remark}</div>}
      <div style={{ opacity: ready ? 1 : 0, transition: 'opacity .6s ease', pointerEvents: ready ? 'auto' : 'none' }}>
        <PrimaryButton onClick={onContinue} style={{ maxWidth: 200 }}>Let&#39;s go</PrimaryButton>
      </div>
    </>
  );
};
