// Payoff beat 2: a short streamed insight + THE one task as a single tappable card (tap = run, 0->1).
// Minimal: no meta-labels stacked around the card. A quiet "or something else" leads to alternatives.
// While the LLM is still generating, a brief thinking state holds the space so nothing pops in raw.

import React, { useState } from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { LineIcon } from '../OnboardingIcons';
import { GhostLink } from '../OnboardingAtoms';
import { StreamingText } from '../StreamingText';
import type { PayoffIdea } from '../onboardingFlowTypes';

const Thinking: React.FC = () => {
  const S = useOnboardingSkin();
  return (
    <div style={{ display: 'flex', gap: 6, height: 40, alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7, height: 7, borderRadius: '50%', background: S.muted,
            animation: 'onboardingThink 1.2s ease-in-out infinite', animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
      <style>{'@keyframes onboardingThink{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}'}</style>
    </div>
  );
};

export const PayoffTask: React.FC<{
  insight: string;
  hero: PayoffIdea;
  generating: boolean;
  onRun: (prompt: string) => void;
  onMore: () => void;
}> = ({ insight, hero, generating, onRun, onMore }) => {
  const S = useOnboardingSkin();
  const [hover, setHover] = useState(false);

  if (generating) return <Thinking />;

  return (
    <>
      <StreamingText
        text={insight}
        style={{ fontFamily: S.serif, fontWeight: 500, fontSize: 30, lineHeight: 1.2, letterSpacing: '-0.005em', color: S.text, maxWidth: 620 }}
      />

      <div
        onClick={() => onRun(hero.prompt)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          marginTop: 32,
          width: '100%',
          maxWidth: 500,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          background: hover ? S.surfaceHover : S.surface,
          border: `1px solid ${hover ? S.borderStrong : S.border}`,
          borderRadius: S.radius,
          padding: '20px 22px',
          cursor: 'pointer',
          textAlign: 'left',
          transform: hover ? 'translateY(-2px)' : 'none',
          transition: 'background .18s ease, border-color .18s ease, transform .18s ease',
        }}
      >
        <span style={{ color: S.accent, display: 'flex', flexShrink: 0 }}>
          <LineIcon name={hero.icon} size={24} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 550 }}>{hero.label}</div>
          <div style={{ marginTop: 3, fontSize: 13, color: S.muted, lineHeight: 1.4 }}>{hero.prompt}</div>
        </div>
        <span style={{ marginLeft: 'auto', color: S.muted, flexShrink: 0 }}>&rarr;</span>
      </div>

      <GhostLink onClick={onMore}>or something else</GhostLink>
    </>
  );
};
