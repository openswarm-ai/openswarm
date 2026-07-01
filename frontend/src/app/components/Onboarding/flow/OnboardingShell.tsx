// The premium frame every onboarding screen sits in: brand pinned top-center, content vertically
// centered, entrance fade (reduced-motion aware). Theme-aware. Portaled to body + near-max z-index
// so it escapes any ancestor transform's stacking context and covers ALL app chrome.

import React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useReducedMotion } from '@/shared/hooks/useReducedMotion';
import { useOnboardingSkin, ONBOARDING_EASE } from './onboardingSkin';
import { Spark } from './OnboardingIcons';

interface Props {
  children: React.ReactNode;
  /** Changing this re-triggers the entrance fade (one per screen). */
  stepKey: string;
}

export const OnboardingShell: React.FC<Props> = ({ children, stepKey }) => {
  const reduce = useReducedMotion();
  const S = useOnboardingSkin();
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        background: S.bg,
        color: S.text,
        fontFamily: S.sans,
        WebkitFontSmoothing: 'antialiased',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'fixed', top: 34, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 9 }}>
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
    </div>,
    document.body,
  );
};
