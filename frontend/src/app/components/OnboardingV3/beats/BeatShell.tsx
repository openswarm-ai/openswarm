import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { useThemeAccent, useThemeWash } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { GRAIN_URL } from '@/shared/styles/grainTexture';

// Arc's torn seam as a SMOOTH wave: a sine sampled densely enough that the polygon reads as a
// soft ripple (no sharp points), ~18px wavelength, 6px swell.
const WAVE_PERIODS = 52;
const WAVE_SAMPLES = WAVE_PERIODS * 8;
const ZIGZAG_CLIP = `polygon(0 0, ${Array.from({ length: WAVE_SAMPLES + 1 }, (unused, i) => {
  const inset = 3 + 3 * Math.sin((i / WAVE_SAMPLES) * WAVE_PERIODS * 2 * Math.PI);
  return `calc(100% - ${inset.toFixed(2)}px) ${((i / WAVE_SAMPLES) * 100).toFixed(3)}%`;
}).join(', ')}, 0 100%)`;

// Arc's electric indigo CTA: onboarding buttons are brand-colored, not user-accent (the accent doesn't exist until the theme beat).
export const CTA_BLUE = '#4b48f8';
// Arc sets its onboarding in a heavy grotesque; the app's token "sans" actually falls back to a
// serif (Anthropic Sans isn't bundled), so the flow pins a real sans stack.
export const ONBOARDING_SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Helvetica, Arial, sans-serif';
// Arc's onboarding-window backdrop: cold azure light from the top-left, deep indigo mid, a WARM
// violet-magenta glow rising from the bottom-right corner, always grained.
export const ARC_BLUE_BG = [
  'radial-gradient(110% 95% at 92% 100%, rgba(186, 70, 235, 0.55) 0%, rgba(146, 60, 244, 0.28) 34%, transparent 62%)',
  'radial-gradient(120% 100% at 6% 4%, rgba(148, 178, 255, 0.85) 0%, rgba(110, 135, 255, 0.35) 38%, transparent 66%)',
  'linear-gradient(152deg, #5f7bff 0%, #4a4ff6 44%, #4338ef 68%, #6f3af3 100%)',
].join(', ');
// Arc's neutral stage: warm mauve-gray under heavy grain (their import beat), until the user picks a color.
const STAGE_MAUVE = '#a8a5b3';

const SPRING = { type: 'spring' as const, stiffness: 260, damping: 26 };

// One idea per room, staged EXACTLY like Arc: the whole window is grained electric blue, a rounded
// split card floats centered in it, dark copy panel (torn right edge, grain, staggered spring+blur
// copy, bottom-pinned CTA) beside a heavily grained stage. `wide` = Arc's account layout instead:
// edge-to-edge 50/50 split, centered copy, no floating card.
const BeatShell: React.FC<{
  c: ClaudeTokens;
  title: string;
  body: string;
  nextLabel: string;
  nextDisabled?: boolean;
  onNext: () => void;
  onBack?: () => void;
  children: React.ReactNode;
  wide?: boolean;
  logo?: React.ReactNode;
  stageDark?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}> = ({ c, title, body, nextLabel, nextDisabled, onNext, onBack, children, wide, logo, stageDark, secondaryLabel, onSecondary }) => {
  // Once the user has picked stops the stage wears them (our theme beat repaints live); before that it stays Arc-mauve.
  const { accent, gradient } = useThemeAccent();
  const { washOpacity, grain } = useThemeWash();
  const stops = gradient ?? (accent ? [accent] : null);
  // Picked color reads VIVID on the stage (alpha floor over near-white), not muddied into the mauve.
  const washAlpha = Math.round(Math.max(0.5, washOpacity) * 255).toString(16).padStart(2, '0');
  const stageBg = stageDark
    ? '#262320'
    : stops
      ? `linear-gradient(115deg, ${stops.map((hex, i) => `${hex}${washAlpha} ${stops.length > 1 ? (i / (stops.length - 1)) * 100 : 100}%`).join(', ')}), #edebe7`
      : STAGE_MAUVE;
  // Arc post-theme: the CTA flips to cream (dark label) and the window backdrop wears the user's
  // stops under a soft white veil; before any pick both stay brand blue.
  const themed = !!stops;
  const ctaBg = themed ? '#F5EFDF' : CTA_BLUE;
  const ctaFg = themed ? '#232320' : '#fff';
  const backdrop = stops
    ? `linear-gradient(rgba(255,255,255,0.16), rgba(255,255,255,0.16)), linear-gradient(160deg, ${stops.map((hex, i) => `${hex} ${stops.length > 1 ? (i / (stops.length - 1)) * 100 : 100}%`).join(', ')})`
    : ARC_BLUE_BG;
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

  const panel = (
    <div
      style={{
        position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column',
        width: wide ? '50%' : 'clamp(300px, 36%, 460px)',
        justifyContent: wide ? 'center' : 'flex-start',
        alignItems: wide ? 'center' : 'stretch',
        textAlign: wide ? 'center' : 'left',
        padding: wide ? '48px 64px' : '56px 40px 36px 44px', boxSizing: 'border-box',
        // Fixed white-on-near-black: the panel is ALWAYS dark, so it never reads theme tokens (dark mode used to turn the copy invisible).
        background: '#1e1e1d', color: '#ffffff', clipPath: ZIGZAG_CLIP,
        fontFamily: ONBOARDING_SANS,
        // Overlap the stage by one tooth-depth (+ sit above it) so the torn edge bites INTO the stage color instead of leaving a dead paper gap.
        marginRight: -6, zIndex: 1,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: 0.07, pointerEvents: 'none', mixBlendMode: 'overlay' }} />
      {onBack && (
        <motion.button
          {...enter(0.05)}
          onClick={() => armed && onBack()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
            marginBottom: 18, padding: 0, border: 'none', background: 'transparent',
            color: 'rgba(255,255,255,0.47)', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
            position: wide ? 'absolute' : 'relative', top: wide ? 24 : undefined, left: wide ? 28 : undefined,
          }}
        >
          <ArrowLeft size={14} /> Back
        </motion.button>
      )}
      {logo && <motion.div {...enter(0.08)} style={{ marginBottom: 18 }}>{logo}</motion.div>}
      <motion.h1 {...enter(0.12)} style={{ margin: 0, fontSize: wide ? 'clamp(2.1rem, 2.8vw, 2.7rem)' : 'clamp(2.1rem, 3.2vw, 3rem)', lineHeight: 1.06, fontWeight: 800, letterSpacing: '-0.02em', fontFamily: 'inherit' }}>
        {title}
      </motion.h1>
      <motion.p {...enter(0.26)} style={{ margin: '18px 0 0', fontSize: '1.04rem', lineHeight: 1.6, color: 'rgba(255,255,255,0.72)', maxWidth: '36ch', whiteSpace: 'pre-line' }}>
        {body}
      </motion.p>
      {/* Arc pins the CTA to the panel's bottom on card beats; on the wide account beat it follows the content. */}
      <motion.div {...enter(0.42)} style={{ marginTop: wide ? 34 : 'auto', paddingTop: wide ? 0 : 28, width: wide ? 'min(340px, 100%)' : '100%' }}>
        <button
          onClick={() => armed && !nextDisabled && onNext()}
          disabled={!!nextDisabled}
          style={{
            width: '100%', padding: '15px 18px', borderRadius: 10,
            border: 'none', background: ctaBg, color: ctaFg,
            fontSize: '1rem', fontWeight: 700, cursor: nextDisabled ? 'default' : 'pointer',
            opacity: nextDisabled ? 0.45 : 1, fontFamily: 'inherit',
            transition: 'background 150ms ease, opacity 150ms ease',
          }}
        >
          {nextLabel}
        </button>
        {/* Arc's quiet escape hatch under the primary CTA. */}
        {secondaryLabel && onSecondary && (
          <button
            onClick={() => armed && onSecondary()}
            style={{
              marginTop: 12, width: '100%', border: 'none', background: 'transparent',
              color: 'rgba(255,255,255,0.55)', fontSize: '0.88rem', fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit', padding: 4,
            }}
          >
            {secondaryLabel}
          </button>
        )}
      </motion.div>
    </div>
  );

  const stage = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.55, delay: 0.15 }}
      style={{
        position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32, boxSizing: 'border-box', overflow: 'auto',
        background: wide ? ARC_BLUE_BG : stageBg,
      }}
    >
      {/* Arc's stage always wears texture; the slider can add more but never strips it during onboarding. */}
      <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: Math.max(0.22, grain), pointerEvents: 'none' }} />
      <div style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </div>
    </motion.div>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', width: '100%', height: '100%', fontFamily: ONBOARDING_SANS }}>
        {panel}
        {stage}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: backdrop, fontFamily: ONBOARDING_SANS }}>
      <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN_URL, opacity: 0.3, pointerEvents: 'none' }} />
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...SPRING, delay: 0.05 }}
        style={{
          position: 'relative', display: 'flex', width: 'min(1240px, 82%)', height: 'min(880px, 82%)',
          borderRadius: 24, overflow: 'hidden', boxShadow: '0 30px 80px rgba(20, 16, 80, 0.35)',
        }}
      >
        {panel}
        {stage}
      </motion.div>
    </div>
  );
};

export default BeatShell;
