// D3: the personalize consent. The short question streams in (shared StreamingText), then a small
// explainer + Yes. "Yes" authorizes the (later) background profiling read; the sub-line says so.

import React, { useState } from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { PrimaryButton, GhostLink } from '../OnboardingAtoms';
import { StreamingText } from '../StreamingText';

const LINE = 'Want me to make this yours?';
const SUB = "I'll take a quick look at what you connect, nothing else.";

export const PersonalizeConsent: React.FC<{ onConsent: (yes: boolean) => void }> = ({ onConsent }) => {
  const S = useOnboardingSkin();
  const [done, setDone] = useState(false);

  return (
    <>
      <StreamingText
        text={LINE}
        onDone={() => setDone(true)}
        style={{ fontFamily: S.serif, fontWeight: 500, fontSize: 33, lineHeight: 1.25, color: S.text }}
      />
      <div style={{ marginTop: 14, fontSize: 15, color: S.muted, opacity: done ? 1 : 0, transition: 'opacity .5s ease' }}>
        {SUB}
      </div>
      <div
        style={{
          marginTop: 30,
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
    </>
  );
};
