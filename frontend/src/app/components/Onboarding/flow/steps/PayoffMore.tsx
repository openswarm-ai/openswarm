// Payoff beat 3: the alternatives. A clean list of runnable tasks; tap one and a real agent runs it.

import React, { useState } from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { LineIcon } from '../OnboardingIcons';
import { Heading } from '../OnboardingAtoms';
import type { PayoffIdea } from '../onboardingFlowTypes';

const Row: React.FC<{ idea: PayoffIdea; onPick: () => void }> = ({ idea, onPick }) => {
  const S = useOnboardingSkin();
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '16px 18px',
        borderRadius: 12,
        cursor: 'pointer',
        background: hover ? S.surfaceHover : S.surface,
        border: `1px solid ${hover ? S.borderStrong : S.border}`,
        transition: 'background .15s ease, border-color .15s ease',
        textAlign: 'left',
      }}
    >
      <span style={{ color: S.accent, display: 'flex', flexShrink: 0 }}>
        <LineIcon name={idea.icon} size={20} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15.5, fontWeight: 500 }}>{idea.label}</div>
        <div style={{ marginTop: 2, fontSize: 12.5, color: S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{idea.prompt}</div>
      </div>
      <span style={{ marginLeft: 'auto', color: S.muted, flexShrink: 0 }}>&rarr;</span>
    </div>
  );
};

export const PayoffMore: React.FC<{ ideas: PayoffIdea[]; onPick: (prompt: string) => void }> = ({ ideas, onPick }) => (
  <>
    <Heading>Or put me on one of these</Heading>
    <div style={{ marginTop: 32, width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 11 }}>
      {ideas.map((idea) => (
        <Row key={idea.id} idea={idea} onPick={() => onPick(idea.prompt)} />
      ))}
    </div>
  </>
);
