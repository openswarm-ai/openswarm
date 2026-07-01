// D2: one field, the name. Claude single-control screen. Enter or Continue advances.

import React, { useState } from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { Heading, Sub, PrimaryButton, GhostLink } from '../OnboardingAtoms';

export const WhatShouldICallYou: React.FC<{
  initialName?: string;
  onContinue: (name: string) => void;
  onSkip: () => void;
}> = ({ initialName = '', onContinue, onSkip }) => {
  const S = useOnboardingSkin();
  const [name, setName] = useState(initialName);
  const [focus, setFocus] = useState(false);
  const submit = () => onContinue(name.trim());

  return (
    <>
      <Heading>What should I call you?</Heading>
      <Sub>so this feels like yours, not a demo</Sub>
      <div style={{ marginTop: 46, width: '100%', maxWidth: 430 }}>
        <input
          autoFocus
          value={name}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            width: '100%',
            background: S.surface,
            border: `1px solid ${focus ? S.accent : S.borderStrong}`,
            borderRadius: 12,
            padding: '15px 18px',
            color: S.text,
            fontSize: 16,
            fontFamily: S.sans,
            textAlign: 'left',
            outline: 'none',
          }}
        />
      </div>
      <PrimaryButton onClick={submit}>Continue</PrimaryButton>
      <GhostLink onClick={onSkip}>skip</GhostLink>
    </>
  );
};
