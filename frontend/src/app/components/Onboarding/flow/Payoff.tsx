// The payoff: name + quirky remark + insight + a prefilled runnable task + tailored "Ideas for you".
// Presentational + theme-aware; the orchestrator feeds it content (persona floor or profile-derived).

import React, { useState } from 'react';
import { useOnboardingSkin } from './onboardingSkin';
import { LineIcon } from './OnboardingIcons';
import { Heading } from './OnboardingAtoms';
import { HoldToLaunch } from './HoldToLaunch';
import type { PayoffIdea } from './onboardingFlowTypes';

const IdeaRow: React.FC<{ idea: PayoffIdea; onPick: () => void }> = ({ idea, onPick }) => {
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
        gap: 13,
        padding: '10px 10px',
        fontSize: 15.5,
        cursor: 'pointer',
        borderRadius: 9,
        background: hover ? S.surface : 'transparent',
        transition: 'background .15s',
      }}
    >
      <span style={{ color: S.muted, width: 22, display: 'flex', justifyContent: 'center' }}>
        <LineIcon name={idea.icon} size={17} />
      </span>
      {idea.label}
    </div>
  );
};

export const Payoff: React.FC<{
  greeting: string;
  remark?: string;
  insight: string;
  prefilledPrompt: string;
  ideas: PayoffIdea[];
  onRun: () => void;
  onPickIdea: (idea: PayoffIdea) => void;
}> = ({ greeting, remark, insight, prefilledPrompt, ideas, onRun, onPickIdea }) => {
  const S = useOnboardingSkin();
  return (
    <>
      <Heading>{greeting}</Heading>
      {remark && <div style={{ marginTop: 10, fontSize: 15, color: S.muted, fontStyle: 'italic' }}>{remark}</div>}
      <div style={{ marginTop: 20, fontSize: 16, color: S.muted, lineHeight: 1.5, maxWidth: 540 }}>{insight}</div>

      <div
        style={{
          marginTop: 26,
          width: '100%',
          maxWidth: 600,
          background: S.surface,
          border: `1px solid ${S.border}`,
          borderRadius: S.radius,
          padding: '20px 22px',
          textAlign: 'left',
        }}
      >
        <div style={{ fontSize: 15.5, lineHeight: 1.55, color: S.text }}>{prefilledPrompt}</div>
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            borderTop: `1px solid ${S.border}`,
            paddingTop: 14,
          }}
        >
          <span style={{ fontSize: 13, color: S.muted }}>hold to send a real agent on it, live</span>
          <HoldToLaunch label="Hold to do it" onLaunch={onRun} />
        </div>
      </div>

      <div style={{ marginTop: 24, width: '100%', maxWidth: 600, textAlign: 'left' }}>
        <div style={{ fontSize: 13, color: S.muted, marginBottom: 8 }}>Or put me on one of these</div>
        {ideas.map((idea) => (
          <IdeaRow key={idea.id} idea={idea} onPick={() => onPickIdea(idea)} />
        ))}
      </div>
    </>
  );
};
