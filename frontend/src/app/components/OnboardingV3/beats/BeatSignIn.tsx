import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import GoogleIcon from '@mui/icons-material/Google';
import EmailIcon from '@mui/icons-material/Email';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchSettings } from '@/shared/state/settingsSlice';
import { OPENSWARM_DEFAULT_PROXY_URL } from '@/shared/config';
import { report } from '@/shared/serviceClient';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import SignInDialog from '@/app/components/overlays/SignInDialog';
import OnboardingLogo from '../OnboardingLogo';
import BeatShell from './BeatShell';

// The account gate: users sign in (Google or email) before anything else, so the free trial and their
// setup are tied to a real account. Google hands off through the external browser and lands out-of-band
// (the cloud page POSTs the bearer to the local backend), so we poll settings until user_id appears.
// Email reuses the proven SignInDialog (magic-link 6-digit code) on top of the beat.
const BeatSignIn: React.FC<{
  c: ClaudeTokens;
  onNext: () => void;
  onBack: () => void;
}> = ({ c, onNext, onBack }) => {
  const dispatch = useAppDispatch();
  const userId = useAppSelector((s) => s.settings.data.user_id ?? null);
  const userEmail = useAppSelector((s) => s.settings.data.user_email ?? null);
  const proxyUrl = useAppSelector((s) => s.settings.data.openswarm_proxy_url || OPENSWARM_DEFAULT_PROXY_URL);
  const installId = useAppSelector((s) => s.settings.data.installation_id ?? '');
  const [waitingGoogle, setWaitingGoogle] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const signedIn = !!userId;

  useEffect(() => {
    if (signedIn || !waitingGoogle) return undefined;
    const id = window.setInterval(() => { void dispatch(fetchSettings()); }, 2000);
    return () => window.clearInterval(id);
  }, [signedIn, waitingGoogle, dispatch]);

  const onGoogle = (): void => {
    if (signedIn) return;
    report('signin', 'google_clicked');
    const localPort = (window as unknown as { __OPENSWARM_PORT__?: number }).__OPENSWARM_PORT__ || 8324;
    const params = new URLSearchParams({ install_id: installId, local_port: String(localPort) });
    const startUrl = `${proxyUrl.replace(/\/$/, '')}/api/auth/google/start?${params.toString()}`;
    const api = (window as unknown as { openswarm?: { openExternal?: (u: string) => void } }).openswarm;
    if (api?.openExternal) api.openExternal(startUrl);
    else window.open(startUrl, '_blank');
    setWaitingGoogle(true);
  };

  const rows: Array<{ id: string; name: string; icon: React.ReactNode; onClick: () => void; hint?: string }> = [
    { id: 'google', name: 'Continue with Google', icon: <GoogleIcon sx={{ fontSize: 20, color: '#4285F4' }} />, onClick: onGoogle, hint: waitingGoogle && !signedIn ? 'Waiting for your browser...' : undefined },
    { id: 'email', name: 'Continue with email', icon: <EmailIcon sx={{ fontSize: 20, color: '#6f6e6a' }} />, onClick: () => { if (!signedIn) setEmailOpen(true); } },
  ];

  return (
    <BeatShell
      c={c}
      title="Sign in."
      body="Your account keeps your setup, and your free trial, tied to you."
      nextLabel="Continue"
      onNext={onNext}
      nextDisabled={!signedIn}
      onBack={onBack}
      wide
      logo={<OnboardingLogo size={52} />}
    >
      <div style={{ width: 'min(380px, 100%)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {signedIn ? (
          // Claude/ChatGPT-style done state: one quiet confirmation card, the buttons step aside.
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px',
              borderRadius: 14, background: '#ffffff', boxShadow: '0 10px 26px rgba(20,16,80,0.22)',
            }}
          >
            <span style={{
              width: 34, height: 34, borderRadius: '50%', background: '#e7f6ee', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <CheckRoundedIcon sx={{ fontSize: 20, color: '#1a9e6a' }} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#2a2a27' }}>You're signed in</span>
              {userEmail && (
                <span style={{ fontSize: '0.8rem', color: '#8a8a86', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userEmail}</span>
              )}
            </span>
          </motion.div>
        ) : (
          <>
            {rows.map((row, i) => (
              // The Claude/ChatGPT auth grammar: full-width white button, brand mark on the left,
              // label centered, thin border, generous height. No decoration doing the talking.
              <motion.button
                key={row.id}
                onClick={row.onClick}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 26, delay: 0.1 + i * 0.08 }}
                style={{
                  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  height: 52, borderRadius: 12, border: '1px solid rgba(0,0,0,0.08)',
                  background: '#ffffff', boxShadow: '0 8px 22px rgba(20,16,80,0.18)',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <span style={{ position: 'absolute', left: 18, display: 'flex', alignItems: 'center' }}>{row.icon}</span>
                <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#2a2a27' }}>
                  {row.hint ? row.hint : row.name}
                </span>
              </motion.button>
            ))}
            <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.65)', textAlign: 'center', marginTop: 2 }}>
              Sign in to continue.
            </div>
          </>
        )}
      </div>
      {emailOpen && !signedIn && <SignInDialog initialStage="email_form" onClose={() => setEmailOpen(false)} />}
    </BeatShell>
  );
};

export default BeatSignIn;
