import React, { useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useThemeAccent, useThemeMode, useThemeWash } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import AccentColorPad from '@/app/components/theme/AccentColorPad';
import BeatShell from './BeatShell';

// The IKEA-effect beat, staged as a physical picker device (Arc/Zen theme gadget): light/dark/system on the bezel, the shared pad (color-theory stops + intensity + grain) as the screen. Every touch drives the REAL app theme live; persistence happens at finish().
const BeatTheme: React.FC<{
  c: ClaudeTokens;
  onNext: () => void;
  onBack: () => void;
}> = ({ c, onNext, onBack }) => {
  const { accent, setAccent, gradient, setGradient } = useThemeAccent();
  const { mode, setMode } = useThemeMode();
  const { washOpacity, grain, setWashOpacity, setGrain } = useThemeWash();
  const stops = gradient ?? (accent ? [accent] : []);
  const onStops = (next: string[] | null) => {
    setAccent(next?.[0] ?? null);
    setGradient(next && next.length > 1 ? next : null);
  };

  // 'system' isn't a persisted mode; it applies the OS preference now and follows it while this beat is mounted.
  const [choice, setChoice] = React.useState<'light' | 'dark' | 'system'>(mode);
  const followSystem = useRef(false);
  const pickSystem = useCallback(() => {
    setChoice('system');
    followSystem.current = true;
    setMode(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, [setMode]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (followSystem.current) setMode(mq.matches ? 'dark' : 'light'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setMode]);
  const pickMode = useCallback((m: 'light' | 'dark') => { followSystem.current = false; setChoice(m); setMode(m); }, [setMode]);

  return (
    <BeatShell
      c={c}
      title="Make it yours."
      body="The whole app repaints as you drag. Add a second dot for a gradient."
      nextLabel="Next"
      onNext={onNext}
      onBack={onBack}
      stageDark
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 220, damping: 24, delay: 0.2 }}
        style={{
          // Fixed dark: the picker is a physical device, it doesn't repaint with the theme it edits.
          width: 'min(430px, 100%)', borderRadius: 20, background: '#141413',
          boxShadow: '0 18px 50px rgba(0,0,0,0.3)', padding: '14px 16px 18px', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <AccentColorPad
          c={c}
          stops={stops}
          onChange={onStops}
          height={210}
          wash={{ opacity: washOpacity, grain, onOpacity: setWashOpacity, onGrain: setGrain }}
          scheme={{ value: choice, onPick: (v) => (v === 'system' ? pickSystem() : pickMode(v)) }}
        />
      </motion.div>
    </BeatShell>
  );
};

export default BeatTheme;
