// D1: one tap on a persona card. The single personalization seed. "just show me" skips to payoff.

import React, { useState } from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { LineIcon } from '../OnboardingIcons';
import { Heading, GhostLink } from '../OnboardingAtoms';
import type { PersonaOption } from '../onboardingFlowTypes';

const PERSONAS: PersonaOption[] = [
  { id: 'work', title: 'My work', description: 'clients, admin, the busywork', icon: 'work', useCase: 'work: clients, admin, busywork' },
  { id: 'personal', title: 'My personal life', description: 'errands, plans, life admin', icon: 'home', useCase: 'personal life: errands, plans, admin' },
  { id: 'build', title: 'Building things', description: 'tools, sites, ideas', icon: 'build', useCase: 'building: tools, sites, ideas' },
];

const Card: React.FC<{ option: PersonaOption; onPick: () => void }> = ({ option, onPick }) => {
  const S = useOnboardingSkin();
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        minHeight: 250,
        padding: '34px 22px',
        borderRadius: S.radius,
        background: hover ? S.surfaceHover : S.surface,
        border: `1px solid ${hover ? S.borderStrong : S.border}`,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'background .18s ease, border-color .18s ease, transform .18s ease',
      }}
    >
      <span style={{ color: S.text, marginTop: 10, marginBottom: 'auto', opacity: 0.92 }}>
        <LineIcon name={option.icon} size={46} strokeWidth={1.3} />
      </span>
      <div style={{ fontFamily: S.serif, fontSize: 21, fontWeight: 500, marginTop: 28 }}>{option.title}</div>
      <div style={{ marginTop: 8, fontSize: 13, color: S.muted, lineHeight: 1.4, maxWidth: 170 }}>{option.description}</div>
    </div>
  );
};

export const WhereDoYouWantHelp: React.FC<{
  onPick: (persona: PersonaOption) => void;
  onSkip: () => void;
}> = ({ onPick, onSkip }) => (
  <>
    <Heading>Where do you want help first?</Heading>
    <div style={{ marginTop: 52, display: 'flex', gap: 18, justifyContent: 'center', width: '100%' }}>
      {PERSONAS.map((p) => (
        <Card key={p.id} option={p} onPick={() => onPick(p)} />
      ))}
    </div>
    <GhostLink onClick={onSkip}>just show me</GhostLink>
  </>
);
