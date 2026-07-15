import React, { useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Monitor, Moon, Sun } from 'lucide-react';
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

  const MODES = [
    { key: 'light' as const, Icon: Sun, onPick: () => pickMode('light') },
    { key: 'dark' as const, Icon: Moon, onPick: () => pickMode('dark') },
    { key: 'system' as const, Icon: Monitor, onPick: pickSystem },
  ];

  return (
    <BeatShell
      c={c}
      title="Make it yours."
      body="The whole app repaints as you drag. Add a second dot for a gradient."
      nextLabel="Next"
      onNext={onNext}
      onBack={onBack}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 220, damping: 24, delay: 0.2 }}
        style={{
          width: 'min(430px, 100%)', borderRadius: 20, background: c.bg.inverse,
          boxShadow: '0 18px 50px rgba(0,0,0,0.3)', padding: '14px 16px 18px', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
          {MODES.map(({ key, Icon, onPick }) => (
            <button
              key={key}
              onClick={onPick}
              title={key.charAt(0).toUpperCase() + key.slice(1)}
              style={{
                width: 34, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: choice === key ? c.accent.primary : 'transparent',
                color: choice === key ? '#fff' : c.text.inverse + '88',
                transition: 'background 140ms ease, color 140ms ease',
              }}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
        <AccentColorPad
          c={c}
          stops={stops}
          onChange={onStops}
          height={210}
          wash={{ opacity: washOpacity, grain, onOpacity: setWashOpacity, onGrain: setGrain }}
        />
      </motion.div>
    </BeatShell>
  );
};

export default BeatTheme;
