// D4: optional connect. The connectors the profiling agent may later read. Skippable; payoff still works.
// UI-only here: real OAuth (integrations.tsx / POST /{tool_id}/oauth/start) wires in a follow step.

import React from 'react';
import { useOnboardingSkin } from '../onboardingSkin';
import { LineIcon } from '../OnboardingIcons';
import { Heading, Sub, PrimaryButton, GhostLink } from '../OnboardingAtoms';
import type { ConnectorOption } from '../onboardingFlowTypes';

const CONNECTORS: ConnectorOption[] = [
  { id: 'google', name: 'Google', description: 'Gmail, Calendar, Drive', icon: 'mail' },
  { id: 'notion', name: 'Notion', description: 'notes, docs, tasks', icon: 'doc' },
  { id: 'slack', name: 'Slack', description: 'messages, channels', icon: 'chat' },
];

const Row: React.FC<{ option: ConnectorOption; connected: boolean; onConnect: () => void }> = ({
  option,
  connected,
  onConnect,
}) => {
  const S = useOnboardingSkin();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: S.surface,
        border: `1px solid ${S.border}`,
        borderRadius: 14,
        padding: '16px 18px',
        textAlign: 'left',
      }}
    >
      <span style={{ color: S.text, opacity: 0.9, display: 'flex' }}>
        <LineIcon name={option.icon} size={20} />
      </span>
      <div>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{option.name}</div>
        <div style={{ fontSize: 12.5, color: S.muted, marginTop: 2 }}>{option.description}</div>
      </div>
      <span
        onClick={connected ? undefined : onConnect}
        style={{
          marginLeft: 'auto',
          fontSize: 13,
          color: connected ? S.muted : S.text,
          background: connected ? 'transparent' : S.surfaceHover,
          border: `1px solid ${connected ? S.border : S.borderStrong}`,
          borderRadius: 999,
          padding: '6px 15px',
          cursor: connected ? 'default' : 'pointer',
        }}
      >
        {connected ? 'Connected' : 'Connect'}
      </span>
    </div>
  );
};

export const ConnectApps: React.FC<{
  connectedIds: string[];
  onConnect: (id: string) => void;
  onContinue: () => void;
  onSkip: () => void;
}> = ({ connectedIds, onConnect, onContinue, onSkip }) => (
  <>
    <Heading>Connect what I can work with</Heading>
    <Sub>optional, and I&#39;ll only ever read it to understand you</Sub>
    <div style={{ marginTop: 44, width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 11 }}>
      {CONNECTORS.map((c) => (
        <Row key={c.id} option={c} connected={connectedIds.includes(c.id)} onConnect={() => onConnect(c.id)} />
      ))}
    </div>
    <PrimaryButton onClick={onContinue} style={{ maxWidth: 200 }}>Continue</PrimaryButton>
    <GhostLink onClick={onSkip}>skip for now</GhostLink>
  </>
);
