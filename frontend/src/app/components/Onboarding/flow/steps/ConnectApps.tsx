// D4: optional connect. Reuses the REAL shared connector catalog (icons + metadata), the REAL
// connection state from toolsSlice, and the REAL create+OAuth thunks. All connectable MCPs, scrollable.

import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { INTEGRATIONS, Integration } from '@/shared/integrations/catalog';
import { useConnectIntegration } from '@/shared/integrations/useConnectIntegration';
import { fetchTools, ToolDefinition } from '@/shared/state/toolsSlice';
import { useOnboardingSkin } from '../onboardingSkin';
import { Heading, Sub, PrimaryButton, GhostLink } from '../OnboardingAtoms';

function toolFor(integration: Integration, items: Record<string, ToolDefinition>): ToolDefinition | undefined {
  return Object.values(items).find((t) => t.name === integration.name);
}

const Row: React.FC<{ integration: Integration }> = ({ integration }) => {
  const S = useOnboardingSkin();
  const connectIntegration = useConnectIntegration();
  const items = useAppSelector((s) => s.tools.items);
  const tool = toolFor(integration, items);
  const connected = tool?.auth_status === 'connected';
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    await connectIntegration(integration, tool);
    setConnecting(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: S.surface, border: `1px solid ${S.border}`, borderRadius: 14, padding: '15px 18px', textAlign: 'left' }}>
      <span style={{ display: 'flex', width: 22, justifyContent: 'center', flexShrink: 0 }}>{integration.icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{integration.name}</div>
        <div style={{ fontSize: 12.5, color: S.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {connected && tool?.connected_account_email ? tool.connected_account_email : integration.description}
        </div>
      </div>
      <span
        onClick={connected || connecting ? undefined : connect}
        style={{
          marginLeft: 'auto',
          flexShrink: 0,
          fontSize: 13,
          color: connected ? S.muted : S.text,
          background: connected ? 'transparent' : S.surfaceHover,
          border: `1px solid ${connected ? S.border : S.borderStrong}`,
          borderRadius: 999,
          padding: '6px 15px',
          cursor: connected || connecting ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          opacity: connecting ? 0.6 : 1,
        }}
      >
        {connected ? 'Connected' : connecting ? 'Connecting…' : 'Connect'}
      </span>
    </div>
  );
};

export const ConnectApps: React.FC<{ onContinue: () => void; onSkip: () => void }> = ({ onContinue, onSkip }) => {
  const dispatch = useAppDispatch();
  // Every connectable MCP from the real catalog (skip the session-borrow ones that need no connecting).
  const shown = INTEGRATIONS.filter((i) => i.authType && i.authType !== 'none');

  useEffect(() => {
    dispatch(fetchTools());
    const onFocus = () => dispatch(fetchTools());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [dispatch]);

  return (
    <>
      <Heading>Connect what I can work with</Heading>
      <Sub>optional, and I&#39;ll only ever read it to understand you</Sub>
      <div
        style={{
          marginTop: 40,
          width: '100%',
          maxWidth: 460,
          maxHeight: 340,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 11,
          padding: '2px 6px',
        }}
      >
        {shown.map((i) => (
          <Row key={i.id} integration={i} />
        ))}
      </div>
      <PrimaryButton onClick={onContinue} style={{ maxWidth: 200 }}>Continue</PrimaryButton>
      <GhostLink onClick={onSkip}>skip for now</GhostLink>
    </>
  );
};
