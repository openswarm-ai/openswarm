import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { API_BASE } from '@/shared/config';
import { fetchModels } from '@/shared/state/modelsSlice';
import { fetchSubscriptionStatus, markSubscriptionConnected, selectSubscriptionConnections } from '@/shared/state/subscriptionsSlice';
import { hasFreeTrialActive, hasModelConnected } from '@/app/components/Onboarding/steps/skipPredicates';
import { SUBSCRIPTION_PROVIDERS } from '@/app/pages/Settings/sections/subscription/subscriptionProviders';
import { runConnectFlow } from '@/app/pages/Settings/sections/subscription/subscriptionConnect';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { ProviderIdentity } from '../onboardingV3Api';
import OnboardingLogo from '../OnboardingLogo';
import { providerLogo } from '../providerLogos';
import BeatShell from './BeatShell';

// The single ask of the whole flow, staged as Arc's import list: radio rows, no filler copy. Reuses the proven Settings connect flow verbatim. Personalization (local scan + one-time chat read) just happens the moment they connect; it's not an opt-in checkbox anymore.
const BeatConnect: React.FC<{
  c: ClaudeTokens;
  identity: ProviderIdentity[];
  onConnected: () => void;
  onNext: () => void;
  onBack: () => void;
}> = ({ c, identity, onConnected, onNext, onBack }) => {
  const dispatch = useAppDispatch();
  const connected = useAppSelector((s) => hasModelConnected(s));
  const freeTrial = useAppSelector((s) => hasFreeTrialActive(s));
  const [connecting, setConnecting] = useState<string | null>(null);
  const [userCode, setUserCode] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedOnce = useRef(false);

  useEffect(() => () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); }, []);

  useEffect(() => {
    if (connected && !connectedOnce.current) {
      connectedOnce.current = true;
      onConnected();
    }
  }, [connected, onConnected]);

  const handleConnect = useCallback(async (providerId: string) => {
    setConnecting(providerId);
    setUserCode('');
    try {
      const res = await fetch(`${API_BASE}/agents/subscriptions/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.detail ?? 'connect failed'));
      runConnectFlow({
        providerId,
        data,
        setConnecting,
        setUserCode,
        setPollTimer: (t) => { pollTimerRef.current = t; },
        fetchStatus: (opts) => dispatch(fetchSubscriptionStatus(opts)).unwrap(),
        refreshPickerModels: () => { dispatch(fetchModels()); },
        markConnected: (provider) => { dispatch(markSubscriptionConnected({ provider })); },
      });
    } catch {
      setConnecting(null);
    }
  }, [dispatch]);

  // Which provider rows are live, so the tab itself shows "Connected", not a floating label below.
  const connections = useAppSelector(selectSubscriptionConnections);
  const connectedIds = new Set(connections.filter((cx) => cx.isActive !== false).map((cx) => cx.provider));
  // The whole flow leans on a real connection (identity, chat-history read, personalized reveal), so
  // there is no skip: Continue stays locked until a provider is connected or the free trial is armed.
  const canContinue = connected || freeTrial;

  return (
    <BeatShell
      c={c}
      title="Connect your AI."
      body="Use the subscription you already pay for."
      nextLabel="Continue"
      onNext={onNext}
      nextDisabled={!canContinue}
      onBack={onBack}
      wide
      logo={<OnboardingLogo size={52} />}
    >
      <div style={{ width: 'min(440px, 100%)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {SUBSCRIPTION_PROVIDERS.map((p, i) => {
          const isThis = connecting === p.id;
          const isConnected = connectedIds.has(p.id);
          return (
            <motion.button
              key={p.id}
              onClick={() => !connected && handleConnect(p.id)}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26, delay: 0.1 + i * 0.08 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '0 0 0 18px', textAlign: 'left', overflow: 'hidden',
                borderRadius: 14, border: 'none', boxShadow: isConnected ? '0 0 0 2px #1a9e6a, 0 10px 26px rgba(20,16,80,0.22)' : '0 10px 26px rgba(20,16,80,0.22)',
                background: '#ffffff', cursor: connected ? 'default' : 'pointer', fontFamily: 'inherit', minHeight: 64,
              }}
            >
              <span style={{
                width: 19, height: 19, borderRadius: 999, flexShrink: 0, boxSizing: 'border-box',
                border: `1.5px solid ${isConnected ? '#1a9e6a' : '#c9c7c2'}`,
                background: isConnected ? '#1a9e6a' : 'transparent',
                boxShadow: isConnected ? 'inset 0 0 0 3px #ffffff' : 'none',
              }} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: '11px 0' }}>
                <span style={{ fontSize: '0.98rem', fontWeight: 600, color: '#3d3d3a' }}>{p.name}</span>
                {/* The green ring + filled radio already signal connected, so no redundant "Connected" text. */}
                {!isConnected && isThis && !connected
                  ? <span style={{ fontSize: '0.78rem', fontWeight: 400, color: '#8a8a86' }}>waiting for sign-in...</span>
                  : null}
              </span>
              {/* Arc's icon tile: a full-height soft-tinted zone on the row's right edge, real brand mark inside. */}
              <span style={{
                alignSelf: 'stretch', width: 78, flexShrink: 0, background: `linear-gradient(135deg, ${p.color}30, ${p.color}14)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {providerLogo(p.id, 28)}
              </span>
            </motion.button>
          );
        })}
        {userCode && !connected && (
          <div style={{ textAlign: 'center', padding: '6px 0', fontSize: '0.9rem', color: 'rgba(255,255,255,0.92)' }}>
            Your code: <strong style={{ fontFamily: c.font.mono, letterSpacing: '0.08em' }}>{userCode}</strong>
          </div>
        )}
        {!canContinue && (
          <div style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>
            Pick a subscription above to continue.
          </div>
        )}
      </div>
    </BeatShell>
  );
};

export default BeatConnect;
