import React from 'react';
import { motion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { useThemeAccent, useThemeMode } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import AccentColorPad from '@/app/components/theme/AccentColorPad';
import BeatShell from './BeatShell';

// The IKEA-effect beat, staged as a physical picker device (Arc's theme gadget): mode icons on the bezel, the shared pad as the screen. Every touch drives the REAL app theme live; persistence happens at finish().
const BeatTheme: React.FC<{
  c: ClaudeTokens;
  onNext: () => void;
  onBack: () => void;
}> = ({ c, onNext, onBack }) => {
  const { accent, setAccent } = useThemeAccent();
  const { mode, setMode } = useThemeMode();

  return (
    <BeatShell
      c={c}
      title="Make it yours."
      body="Pick a color, any color. The whole app repaints as you drag; this is your home now."
      nextLabel="Continue"
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
          {(['light', 'dark'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={m === 'light' ? 'Light' : 'Dark'}
              style={{
                width: 34, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: mode === m ? c.accent.primary : 'transparent',
                color: mode === m ? '#fff' : c.text.inverse + '88',
                transition: 'background 140ms ease, color 140ms ease',
              }}
            >
              {m === 'light' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          ))}
        </div>
        <AccentColorPad c={c} accent={accent} onPick={setAccent} height={210} />
      </motion.div>
    </BeatShell>
  );
};

export default BeatTheme;
