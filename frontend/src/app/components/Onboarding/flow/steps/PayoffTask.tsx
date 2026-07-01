// Payoff beat 2: the insight + THE one task, as a single tappable card. Tap it and a real agent runs
// it (0 -> 1). A quiet "or something else" leads to the alternatives beat.

import React, { useState } from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { LineIcon } from '../OnboardingIcons';
import { Heading, GhostLink } from '../OnboardingAtoms';
import type { PayoffIdea } from '../onboardingFlowTypes';

export const PayoffTask: React.FC<{
  insight: string;
  hero: PayoffIdea;
  onRun: (prompt: string) => void;
  onMore: () => void;
}> = ({ insight, hero, onRun, onMore }) => {
  const S = useOnboardingSkin();
  const [hover, setHover] = useState(false);

  return (
    <>
      <Heading>{insight}</Heading>
      <div style={{ marginTop: 14, fontSize: 15, color: S.muted }}>Here&#39;s the one I&#39;d start with:</div>

      <div
        onClick={() => onRun(hero.prompt)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          marginTop: 22,
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          background: hover ? S.surfaceHover : S.surface,
          border: `1px solid ${hover ? S.borderStrong : S.border}`,
          borderRadius: S.radius,
          padding: '22px 24px',
          cursor: 'pointer',
          textAlign: 'left',
          transform: hover ? 'translateY(-2px)' : 'none',
          transition: 'background .18s ease, border-color .18s ease, transform .18s ease',
        }}
      >
        <span style={{ color: S.accent, display: 'flex', flexShrink: 0 }}>
          <LineIcon name={hero.icon} size={26} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 550 }}>{hero.label}</div>
          <div style={{ marginTop: 4, fontSize: 13.5, color: S.muted, lineHeight: 1.4 }}>{hero.prompt}</div>
        </div>
        <span style={{ marginLeft: 'auto', color: S.muted, flexShrink: 0 }}>&rarr;</span>
      </div>

      <div style={{ marginTop: 14, fontSize: 12.5, color: S.muted }}>a real agent goes and does this, live</div>
      <GhostLink onClick={onMore}>or something else</GhostLink>
    </>
  );
};
