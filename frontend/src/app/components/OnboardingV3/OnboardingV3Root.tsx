import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { setFlowActive } from '@/shared/state/onboardingV3Slice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useOnboardingV3Pipeline } from './useOnboardingV3Pipeline';
import BeatConnect from './BeatConnect';
import BeatApps from './BeatApps';
import BeatTheme from './BeatTheme';

type Beat = 'welcome' | 'newos' | 'connect' | 'apps' | 'theme';

const V2_STORAGE_KEY = 'openswarm.onboarding.v2';

// Decides whether the v3 full-screen flow owns this launch. Only genuinely fresh installs see it: anyone with the v2 tour key or existing sessions is auto-marked skipped so an update never re-onboards a veteran.
function useOnboardingV3Gate(): boolean {
  const dispatch = useAppDispatch();
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const v3State = useAppSelector((s) => s.settings.data.onboarding_v3);
  const flowActive = useAppSelector((s) => s.onboardingV3.flowActive);
  const sessionCount = useAppSelector((s) => Object.keys(s.agents.sessions).length);

  const hasV2History = useMemo(() => {
    try { return localStorage.getItem(V2_STORAGE_KEY) !== null; } catch { return false; }
  }, []);

  useEffect(() => {
    if (!settingsLoaded || v3State) return;
    if (hasV2History) {
      dispatch(updateSettingsPatch({ onboarding_v3: 'skipped' }));
      return;
    }
    dispatch(setFlowActive(true));
  }, [settingsLoaded, v3State, hasV2History, dispatch]);

  // Backstop for a veteran who cleared localStorage: real sessions arriving mid-flow means this is not a fresh install.
  useEffect(() => {
    if (!flowActive || sessionCount === 0) return;
    dispatch(setFlowActive(false));
    dispatch(updateSettingsPatch({ onboarding_v3: 'skipped' }));
  }, [flowActive, sessionCount, dispatch]);

  return flowActive && settingsLoaded && !v3State;
}

// Full-bleed intro rooms: a soft accent blob blooms behind giant type, one arrow, nothing else.
const IntroBeat: React.FC<{ c: ClaudeTokens; line: string; sub?: string; onNext: () => void }> = ({ c, line, sub, onNext }) => (
  <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: c.bg.inverse, overflow: 'hidden' }}>
    <motion.div
      initial={{ scale: 0.35, opacity: 0 }}
      animate={{ scale: 1, opacity: 0.55 }}
      transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
      style={{
        position: 'absolute', width: 560, height: 560, borderRadius: 999,
        background: `radial-gradient(circle at 42% 38%, ${c.accent.hover}, ${c.accent.primary} 55%, transparent 75%)`,
        filter: 'blur(70px)', pointerEvents: 'none',
      }}
    />
    <motion.h1
      initial={{ opacity: 0, y: 16, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
      style={{ position: 'relative', margin: 0, fontSize: 'clamp(2.6rem, 6vw, 4.4rem)', fontWeight: 700, color: c.text.inverse, letterSpacing: '-0.02em', textAlign: 'center', padding: '0 24px' }}
    >
      {line}
    </motion.h1>
    {sub && (
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.8 }}
        style={{ position: 'relative', margin: '14px 0 0', fontSize: '1.05rem', color: c.text.inverse + '99' }}
      >
        {sub}
      </motion.p>
    )}
    <motion.button
      onClick={onNext}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 1.05 }}
      whileHover={{ scale: 1.06 }}
      style={{
        position: 'relative', marginTop: 44, width: 54, height: 40, borderRadius: 12, border: 'none',
        background: 'rgba(255,255,255,0.92)', color: '#1a1a18', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <ArrowRight size={19} />
    </motion.button>
  </div>
);

// Onboarding v3: connect-first, Arc/Zen-style staged rooms over the live app. Each beat commits its side effect on exit; the overlay dissolving IS the reveal (the seeder has already dressed the canvas behind it).
const OnboardingV3Root: React.FC = () => {
  const active = useOnboardingV3Gate();
  const c = useClaudeTokens();
  const pipeline = useOnboardingV3Pipeline();
  const [beat, setBeat] = useState<Beat>('welcome');
  const [scanConsent, setScanConsent] = useState(true);
  const [picks, setPicks] = useState<string[]>([]);
  const [finishing, setFinishing] = useState(false);

  const { kickIdentity, kickScan, kickPrep, finish } = pipeline;

  const onConnected = useCallback(() => {
    kickIdentity();
    kickScan(scanConsent);
  }, [kickIdentity, kickScan, scanConsent]);

  const leaveConnect = useCallback(() => {
    kickScan(scanConsent);
    setBeat('apps');
  }, [kickScan, scanConsent]);

  const leaveApps = useCallback(() => {
    kickPrep(picks);
    setBeat('theme');
  }, [kickPrep, picks]);

  const leaveTheme = useCallback(async () => {
    setFinishing(true);
    await finish('done');
  }, [finish]);

  const skipAll = useCallback(() => { void finish('skipped'); }, [finish]);

  // AnimatePresence stays mounted so the overlay's exit fade (the curtain lift) actually plays when active flips false.
  return (
    <AnimatePresence>
      {active && (
      <motion.div
        key="onboarding-v3"
        exit={{ opacity: 0 }}
        transition={{ duration: 0.6 }}
        style={{ position: 'fixed', inset: 0, zIndex: 100000, background: c.bg.page }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={beat}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.32 }}
            style={{ width: '100%', height: '100%' }}
          >
            {beat === 'welcome' && <IntroBeat c={c} line="Welcome." onNext={() => setBeat('newos')} />}
            {beat === 'newos' && <IntroBeat c={c} line="This is your new OS." sub="A canvas where AI agents do real work for you." onNext={() => setBeat('connect')} />}
            {beat === 'connect' && (
              <BeatConnect
                c={c}
                identity={pipeline.identity}
                scanConsent={scanConsent}
                setScanConsent={setScanConsent}
                onConnected={onConnected}
                onNext={leaveConnect}
                onBack={() => setBeat('newos')}
              />
            )}
            {beat === 'apps' && <BeatApps c={c} picks={picks} setPicks={setPicks} onNext={leaveApps} onBack={() => setBeat('connect')} />}
            {beat === 'theme' && <BeatTheme c={c} onNext={() => { void leaveTheme(); }} onBack={() => setBeat('apps')} />}
          </motion.div>
        </AnimatePresence>
        {finishing && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: c.bg.page }}>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{ fontSize: '1.05rem', color: c.text.tertiary }}
            >
              Setting up your canvas...
            </motion.div>
          </div>
        )}
        {!finishing && (
          <button
            onClick={skipAll}
            style={{
              position: 'absolute', bottom: 18, left: 20, border: 'none', background: 'transparent',
              color: c.text.tertiary, fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit', padding: 4,
            }}
          >
            Skip setup
          </button>
        )}
      </motion.div>
      )}
    </AnimatePresence>
  );
};

export default OnboardingV3Root;
