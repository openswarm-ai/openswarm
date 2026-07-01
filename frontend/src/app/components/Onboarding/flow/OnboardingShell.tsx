// The premium frame every onboarding screen sits in: brand pinned top-center, content
// vertically centered, entrance fade (reduced-motion aware), and the discovery progress dots.

import React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';
import { ONBOARDING_SKIN as S, ONBOARDING_EASE } from './onboardingSkin';
import { Spark } from './OnboardingIcons';

interface Props {
  children: React.ReactNode;
  /** Changing this re-triggers the entrance fade (one per screen). */
  stepKey: string;
  /** 0-based; when set with totalSteps, renders the bottom dots. */
  stepIndex?: number;
  totalSteps?: number;
}

// Portaled to document.body + a near-max z-index so it escapes any ancestor transform's stacking
// context and covers ALL app chrome (the ⌘K search bar, headers). This is the real takeover layer.
const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483000,
  background: S.bg,
  color: S.text,
  fontFamily: S.sans,
  WebkitFontSmoothing: 'antialiased',
  overflow: 'hidden',
};

export const OnboardingShell: React.FC<Props> = ({ children, stepKey, stepIndex, totalSteps }) => {
  const reduce = useReducedMotion();
  const showDots = typeof stepIndex === 'number' && typeof totalSteps === 'number';
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div style={overlay}>
      <div
        style={{
          position: 'fixed',
          top: 34,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
        }}
      >
        <span style={{ lineHeight: 0 }}>
          <Spark size={20} color={S.accent} />
        </span>
        <span style={{ fontFamily: S.serif, fontSize: 25, fontWeight: 500, letterSpacing: 0.2 }}>OpenSwarm</span>
      </div>

      <motion.div
        key={stepKey}
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0 : 0.5, ease: ONBOARDING_EASE }}
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
        }}
      >
        <div style={{ width: 'min(720px, 88vw)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {children}
        </div>
      </motion.div>

      {showDots && (
        <div style={{ position: 'fixed', bottom: 40, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 9 }}>
          {Array.from({ length: totalSteps as number }).map((unused, i) => (
            <span
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: i === stepIndex ? S.accent : 'rgba(243,241,234,0.16)',
              }}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
};
