import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { updateSettingsPatch } from '@/shared/state/settingsSlice';
import { setFlowActive } from '@/shared/state/onboardingV3Slice';
import { selectSubscriptionConnections } from '@/shared/state/subscriptionsSlice';
import { useClaudeTokens, useThemeAccent } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useOnboardingV3Pipeline } from './useOnboardingV3Pipeline';
import { GRAIN_URL } from '@/shared/styles/grainTexture';
import { ARC_BLUE_BG, ONBOARDING_SANS } from './beats/BeatShell';
import BeatSignIn from './beats/BeatSignIn';
import BeatConnect from './beats/BeatConnect';
import BeatApps from './beats/BeatApps';
import BeatTheme from './beats/BeatTheme';
import BeatCard from './beats/BeatCard';

type Beat = 'welcome' | 'newos' | 'signin' | 'connect' | 'apps' | 'theme' | 'card';

const V2_STORAGE_KEY = 'openswarm.onboarding.v2';
const WINDOWED_BEATS: Beat[] = ['welcome', 'newos'];

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

  // Dev/QA only (stripped from production builds): localStorage 'osw_force_onboarding'='1' replays the
  // v3 flow on a non-fresh install, since the gate is otherwise first-install-only. Lets us showcase
  // + live-test the whole flow without a truly clean profile.
  const forceShow = useMemo(() => {
    if (process.env.NODE_ENV === 'production') return false;
    try { return localStorage.getItem('osw_force_onboarding') === '1'; } catch { return false; }
  }, []);

  // Under the replay flag we open the flow exactly ONCE (a ref, not on every v3State change) so that
  // finish() setting flowActive=false actually closes the curtain instead of the effect re-opening it.
  const forcedOpenRef = useRef(false);
  useEffect(() => {
    if (forceShow) {
      if (!forcedOpenRef.current) { forcedOpenRef.current = true; dispatch(setFlowActive(true)); }
      return;
    }
    if (!settingsLoaded || v3State) return;
    if (hasV2History) {
      dispatch(updateSettingsPatch({ onboarding_v3: 'skipped' }));
      return;
    }
    dispatch(setFlowActive(true));
  }, [settingsLoaded, v3State, hasV2History, dispatch, forceShow]);

  // Backstop for a veteran who cleared localStorage: real sessions arriving mid-flow means this is not a fresh install. (Skipped under the dev replay flag, whose demo dashboard legitimately has sessions.)
  useEffect(() => {
    if (forceShow || !flowActive || sessionCount === 0) return;
    dispatch(setFlowActive(false));
    dispatch(updateSettingsPatch({ onboarding_v3: 'skipped' }));
  }, [flowActive, sessionCount, dispatch, forceShow]);

  // forceShow bypasses the v2/v3 ENTRY block but still respects flowActive, so finish() closes it.
  return forceShow ? (flowActive && settingsLoaded) : (flowActive && settingsLoaded && !v3State);
}

// Full-bleed intro room, Arc's "A browser for you.": giant heavy white type centered on the grained
// electric-blue gradient, one arrow, nothing else.
const IntroBeat: React.FC<{ c: ClaudeTokens; line: string; sub?: string; onNext: () => void }> = ({ c, line, sub, onNext }) => (
  <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: ARC_BLUE_BG, overflow: 'hidden', fontFamily: ONBOARDING_SANS }}>
    <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: 0.32, pointerEvents: 'none' }} />
    <motion.h1
      initial={{ opacity: 0, y: 16, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, delay: 0.45, ease: [0.22, 1, 0.36, 1] }}
      style={{ position: 'relative', margin: 0, fontSize: 'clamp(2.8rem, 5.4vw, 4.4rem)', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', textAlign: 'center', padding: '0 24px', fontFamily: 'inherit' }}
    >
      {line}
    </motion.h1>
    {sub && (
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.8 }}
        style={{ position: 'relative', margin: '14px 0 0', fontSize: '1.02rem', color: 'rgba(255,255,255,0.75)' }}
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
  const [picks, setPicks] = useState<string[]>([]);
  const connectedProvider = useAppSelector((s) => selectSubscriptionConnections(s).find((cx) => cx.isActive !== false)?.provider ?? null);
  const { accent, gradient } = useThemeAccent();

  const { kickIdentity, kickScan, kickUsageRead, kickPrep, finish } = pipeline;

  // Start ALL the background work the instant they connect: identity + scan + usage + prep + the
  // audit/app jobs. They then run through the entire rest of the flow (connect -> apps -> theme ->
  // card), so the reveal lands on work already well underway. Personalization is default-on (no
  // opt-in checkbox), so scan + chat-read always fire here. kickPrep is idempotent and awaits the
  // scan/usage promises just kicked here; picks aren't in yet and prep doesn't gate on them.
  const onConnected = useCallback(() => {
    kickIdentity();
    kickScan(true);
    if (connectedProvider) kickUsageRead(connectedProvider, true);
    kickPrep(picks);
  }, [kickIdentity, kickScan, kickUsageRead, kickPrep, connectedProvider, picks]);

  // Backstop: onConnected fires prep for subscription/api-key connects; this covers any path where it
  // didn't (e.g. free trial). Idempotent, so it's a no-op when prep already started at connect.
  const leaveConnect = useCallback(() => {
    kickScan(true);
    kickPrep(picks);
    setBeat('apps');
  }, [kickScan, kickPrep, picks]);

  const leaveApps = useCallback(() => {
    kickPrep(picks);
    setBeat('theme');
  }, [kickPrep, picks]);

  const leaveCard = useCallback((name: string | null) => {
    if (name) dispatch(updateSettingsPatch({ user_name: name }));
    // finish() is now non-blocking: it stages the reveal + drops flowActive immediately, so the overlay
    // fades straight onto the live canvas (jobs already in motion). No "Setting up your canvas" spinner.
    void finish('done');
  }, [dispatch, finish]);


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
              {beat === 'newos' && <IntroBeat c={c} line="This is your new OS." onNext={() => setBeat('signin')} />}
              {beat === 'signin' && <BeatSignIn c={c} onNext={() => setBeat('connect')} onBack={() => setBeat('newos')} />}
              {beat === 'connect' && (
                <BeatConnect
                  c={c}
                  identity={pipeline.identity}
                  onConnected={onConnected}
                  onNext={leaveConnect}
                  onBack={() => setBeat('signin')}
                />
              )}
              {beat === 'apps' && <BeatApps c={c} picks={picks} setPicks={setPicks} onNext={leaveApps} onBack={() => setBeat('connect')} />}
              {beat === 'theme' && <BeatTheme c={c} onNext={() => setBeat('card')} onBack={() => setBeat('apps')} />}
              {beat === 'card' && <BeatCard c={c} identity={pipeline.identity} onFinish={(name) => { void leaveCard(name); }} onBack={() => setBeat('theme')} />}
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>
  );
};

export default OnboardingV3Root;
