import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { setFlowActive } from '@/shared/state/onboardingV3Slice';
import { selectSubscriptionConnections } from '@/shared/state/subscriptionsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useOnboardingV3Pipeline } from './useOnboardingV3Pipeline';
import { GRAIN_URL } from './beats/BeatShell';
import Starburst from './Starburst';
import BeatConnect from './beats/BeatConnect';
import BeatApps from './beats/BeatApps';
import BeatTheme from './beats/BeatTheme';
import BeatCard from './beats/BeatCard';

type Beat = 'welcome' | 'newos' | 'connect' | 'apps' | 'theme' | 'card';

const V2_STORAGE_KEY = 'openswarm.onboarding.v2';
const WINDOWED_BEATS: Beat[] = ['welcome', 'newos'];
// The opening is its own vivid moment (electric blue -> indigo -> violet), deliberately off-brand; the user's picked color takes over from the theme beat on.
const INTRO = { core: '#93b5ff', mid: '#5b6cff', edge: '#a855f7' };

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

// Full-bleed intro room: a soft accent blob drifts once behind giant type, one arrow, nothing else.
const IntroBeat: React.FC<{ c: ClaudeTokens; line: string; sub?: string; onNext: () => void }> = ({ c, line, sub, onNext }) => (
  <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: c.bg.inverse, overflow: 'hidden' }}>
    <motion.div
      initial={{ scale: 0.35, opacity: 0, x: 0, y: 0 }}
      animate={{ scale: [0.35, 1, 1.06, 1], opacity: [0, 0.7, 0.62, 0.7], x: [0, 0, 22, 0], y: [0, 0, -14, 0] }}
      transition={{ duration: 9, times: [0, 0.16, 0.6, 1], ease: 'easeInOut' }}
      style={{
        position: 'absolute', width: 620, height: 620, borderRadius: 999,
        background: `radial-gradient(circle at 42% 38%, ${INTRO.core}, ${INTRO.mid} 46%, ${INTRO.edge} 70%, transparent 82%)`,
        filter: 'blur(64px)', pointerEvents: 'none',
      }}
    />
    <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: 0.14, pointerEvents: 'none', mixBlendMode: 'overlay' }} />
    <motion.div
      initial={{ opacity: 0, scale: 0.4, rotate: -80 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 160, damping: 18, delay: 0.2 }}
      style={{ position: 'relative', marginBottom: 22 }}
    >
      <Starburst size={44} from={INTRO.core} to={INTRO.edge} />
    </motion.div>
    <motion.h1
      initial={{ opacity: 0, y: 16, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, delay: 0.45, ease: [0.22, 1, 0.36, 1] }}
      style={{ position: 'relative', margin: 0, fontSize: 'clamp(2.4rem, 5vw, 3.8rem)', fontWeight: 600, color: c.text.inverse, letterSpacing: '-0.01em', textAlign: 'center', padding: '0 24px' }}
    >
      {line}
    </motion.h1>
    {sub && (
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.8 }}
        style={{ position: 'relative', margin: '14px 0 0', fontSize: '1.02rem', color: c.text.inverse + '99' }}
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
        position: 'relative', marginTop: 40, width: 54, height: 40, borderRadius: 12, border: 'none',
        background: 'rgba(255,255,255,0.92)', color: '#1a1a18', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <ArrowRight size={19} />
    </motion.button>
  </div>
);

// Onboarding v3, staged like Arc: a floating window births over the dimmed canvas, expands to own the screen on the first commitment, then each beat is a room. Side effects commit on beat exit; the overlay dissolving IS the reveal.
const OnboardingV3Root: React.FC = () => {
  const active = useOnboardingV3Gate();
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const pipeline = useOnboardingV3Pipeline();
  const [beat, setBeat] = useState<Beat>('welcome');
  const [scanConsent, setScanConsent] = useState(true);
  const [usageConsent, setUsageConsent] = useState(true);
  const [picks, setPicks] = useState<string[]>([]);
  const connectedProvider = useAppSelector((s) => selectSubscriptionConnections(s).find((cx) => cx.isActive !== false)?.provider ?? null);
  const [finishing, setFinishing] = useState(false);

  const { kickIdentity, kickScan, kickUsageRead, kickPrep, finish } = pipeline;

  const onConnected = useCallback(() => {
    kickIdentity();
    kickScan(scanConsent);
    if (connectedProvider) kickUsageRead(connectedProvider, usageConsent);
  }, [kickIdentity, kickScan, kickUsageRead, scanConsent, usageConsent, connectedProvider]);

  // Fire prep + the background jobs at connect-exit (scan/usage/identity are all ready by now), so they run through the apps + theme + card beats (~three beats of runway) and the reveal lands on work well underway, not just-started. kickPrep is idempotent; picks arrive a beat later and feed the reveal's connect suggestions, not the already-launched jobs.
  const leaveConnect = useCallback(() => {
    kickScan(scanConsent);
    kickPrep(picks);
    setBeat('apps');
  }, [kickScan, kickPrep, scanConsent, picks]);

  const leaveApps = useCallback(() => {
    kickPrep(picks);
    setBeat('theme');
  }, [kickPrep, picks]);

  const leaveCard = useCallback(async (name: string | null) => {
    if (name) dispatch(updateSettingsPatch({ user_name: name }));
    setFinishing(true);
    await finish('done');
  }, [dispatch, finish]);

  const skipAll = useCallback(() => { void finish('skipped'); }, [finish]);

  const windowed = WINDOWED_BEATS.includes(beat);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Expanded beats cap at a large centered card (not edge-to-edge) so on very wide displays the stage never balloons into a beige void around the sparse content.
  const stageW = windowed ? Math.min(900, Math.round(vw * 0.72)) : Math.min(1680, Math.round(vw * 0.94));
  const stageH = windowed ? Math.min(560, Math.round(vh * 0.74)) : Math.min(1000, Math.round(vh * 0.92));

  // AnimatePresence stays mounted so the overlay's exit fade (the curtain lift) actually plays when active flips false.
  return (
    <AnimatePresence>
      {active && (
      <motion.div
        key="onboarding-v3"
        exit={{ opacity: 0 }}
        transition={{ duration: 0.6 }}
        style={{
          position: 'fixed', inset: 0, zIndex: 100000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(10, 10, 9, 0.42)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.72, filter: 'blur(18px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', width: stageW, height: stageH, borderRadius: 16 }}
          transition={{ type: 'spring', stiffness: 170, damping: 24, mass: 0.9 }}
          style={{
            position: 'relative', overflow: 'hidden',
            boxShadow: '0 30px 90px rgba(0,0,0,0.5)',
            background: c.bg.page,
          }}
        >
          <AnimatePresence initial={false}>
            <motion.div
              key={beat}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeInOut' }}
              style={{ position: 'absolute', inset: 0 }}
            >
              {beat === 'welcome' && <IntroBeat c={c} line="Welcome." onNext={() => setBeat('newos')} />}
              {beat === 'newos' && <IntroBeat c={c} line="This is your new OS." onNext={() => setBeat('connect')} />}
              {beat === 'connect' && (
                <BeatConnect
                  c={c}
                  identity={pipeline.identity}
                  scanConsent={scanConsent}
                  setScanConsent={setScanConsent}
                  usageConsent={usageConsent}
                  setUsageConsent={setUsageConsent}
                  onConnected={onConnected}
                  onNext={leaveConnect}
                  onBack={() => setBeat('newos')}
                />
              )}
              {beat === 'apps' && <BeatApps c={c} picks={picks} setPicks={setPicks} onNext={leaveApps} onBack={() => setBeat('connect')} />}
              {beat === 'theme' && <BeatTheme c={c} onNext={() => setBeat('card')} onBack={() => setBeat('apps')} />}
              {beat === 'card' && <BeatCard c={c} identity={pipeline.identity} onFinish={(name) => { void leaveCard(name); }} onBack={() => setBeat('theme')} />}
            </motion.div>
          </AnimatePresence>
          {/* Traffic lights sell the floating window during the intro; they fade as the window takes the screen. */}
          <motion.div
            animate={{ opacity: windowed ? 1 : 0 }}
            transition={{ duration: 0.3 }}
            style={{ position: 'absolute', top: 13, left: 14, display: 'flex', gap: 7, pointerEvents: 'none' }}
          >
            {['#FF5F57', '#FEBC2E', '#28C840'].map((dot) => (
              <span key={dot} style={{ width: 11, height: 11, borderRadius: 999, background: dot, opacity: 0.9 }} />
            ))}
          </motion.div>
          {finishing && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center', justifyContent: 'center', background: c.bg.page }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: [0, 1, 0.55, 1], scale: [0.7, 1, 0.92, 1], rotate: [0, 0, 22, 45] }}
                transition={{ duration: 4.5, times: [0, 0.2, 0.6, 1], repeat: 3 }}
              >
                <Starburst size={40} from={c.accent.hover} to={c.accent.pressed} />
              </motion.div>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ fontSize: '1.02rem', color: c.text.tertiary }}>
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
      </motion.div>
      )}
    </AnimatePresence>
  );
};

export default OnboardingV3Root;
