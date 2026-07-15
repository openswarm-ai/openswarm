import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

// Split-stage layout for the interactive beats: dark copy panel left, live artifact right. One loud button, a whisper Back, no progress bar; each beat is a room, not step 3 of 9.
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
  // Zen steal: controls stay inert until the entrance animation lands so a double-click from the prior beat can't fire them.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 450);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <motion.div
        initial={{ opacity: 0, x: -24 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{
          width: 'min(400px, 36%)', flexShrink: 0, display: 'flex', flexDirection: 'column',
          justifyContent: 'center', padding: '48px 44px', boxSizing: 'border-box',
          background: c.bg.inverse, color: c.text.inverse,
        }}
      >
        {onBack && (
          <button
            onClick={() => armed && onBack()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
              marginBottom: 18, padding: 0, border: 'none', background: 'transparent',
              color: c.text.inverse + '77', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <ArrowLeft size={14} /> Back
          </button>
        )}
        <h1 style={{ margin: 0, fontSize: 'clamp(1.9rem, 3.2vw, 2.6rem)', lineHeight: 1.12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          {title}
        </h1>
        <p style={{ margin: '16px 0 0', fontSize: '0.98rem', lineHeight: 1.55, color: c.text.inverse + '99', maxWidth: '34ch' }}>
          {body}
        </p>
        <div style={{ marginTop: 40 }}>
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
        </div>
      </motion.div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.55, delay: 0.12 }}
        style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: c.bg.page, padding: 36, boxSizing: 'border-box', overflow: 'auto',
        }}
      >
        {children}
      </motion.div>
    </div>
  );
};

export default BeatShell;
