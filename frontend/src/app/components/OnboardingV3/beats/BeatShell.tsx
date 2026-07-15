import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

// Film grain as a data URI so the CSP never phones out; opacity keeps it a texture, not noise.
export const GRAIN_URL = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

// Arc's torn seam: the dark copy panel ends in a zigzag bite instead of a straight border.
const ZIGZAG_CLIP = `polygon(0 0, 100% 0, ${Array.from({ length: 50 }, (unused, i) => `calc(100% - 6px) ${i * 2 + 1}%, 100% ${i * 2 + 2}%`).join(', ')}, 0 100%)`;

const SPRING = { type: 'spring' as const, stiffness: 260, damping: 26 };

// One idea per room: dark copy panel left (torn edge, grain, staggered spring+blur copy), live artifact on a grained stage right. Copy never moves after it lands; only the artifact is alive.
const BeatShell: React.FC<{
  c: ClaudeTokens;
  title: string;
  body: string;
  nextLabel: string;
  nextDisabled?: boolean;
  onNext: () => void;
  onBack?: () => void;
  children: React.ReactNode;
}> = ({ c, title, body, nextLabel, nextDisabled, onNext, onBack, children }) => {
  // Zen steal: controls stay inert until the entrance lands so a double-click from the prior beat can't fire them.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 600);
    return () => window.clearTimeout(t);
  }, []);

  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 14, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { ...SPRING, delay },
  });

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', background: c.bg.secondary }}>
      <div
        style={{
          position: 'relative', width: 'min(400px, 36%)', flexShrink: 0, display: 'flex', flexDirection: 'column',
          justifyContent: 'center', padding: '48px 46px 48px 44px', boxSizing: 'border-box',
          background: c.bg.inverse, color: c.text.inverse, clipPath: ZIGZAG_CLIP,
        }}
      >
        <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: 0.16, pointerEvents: 'none', mixBlendMode: 'overlay' }} />
        {onBack && (
          <motion.button
            {...enter(0.05)}
            onClick={() => armed && onBack()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
              marginBottom: 18, padding: 0, border: 'none', background: 'transparent',
              color: c.text.inverse + '77', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <ArrowLeft size={14} /> Back
          </motion.button>
        )}
        <motion.h1 {...enter(0.12)} style={{ margin: 0, fontSize: 'clamp(1.9rem, 3.2vw, 2.6rem)', lineHeight: 1.12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          {title}
        </motion.h1>
        <motion.p {...enter(0.26)} style={{ margin: '16px 0 0', fontSize: '0.98rem', lineHeight: 1.55, color: c.text.inverse + '99', maxWidth: '34ch' }}>
          {body}
        </motion.p>
        <motion.div {...enter(0.42)} style={{ marginTop: 40 }}>
          <button
            onClick={() => armed && !nextDisabled && onNext()}
            disabled={!!nextDisabled}
            style={{
              width: '100%', padding: '13px 18px', borderRadius: c.radius.md,
              border: 'none', background: c.accent.primary, color: '#fff',
              fontSize: '0.98rem', fontWeight: 600, cursor: nextDisabled ? 'default' : 'pointer',
              opacity: nextDisabled ? 0.45 : 1, fontFamily: 'inherit',
              transition: 'background 150ms ease, opacity 150ms ease',
            }}
          >
            {nextLabel}
          </button>
        </motion.div>
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.55, delay: 0.15 }}
        style={{
          position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 36, boxSizing: 'border-box', overflow: 'auto',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: 0.07, pointerEvents: 'none' }} />
        <div style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {children}
        </div>
      </motion.div>
    </div>
  );
};

export default BeatShell;
