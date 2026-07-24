import React, { useCallback, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy, Dices, Download, Share } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { hexToHsl, hslToHex } from '@/shared/styles/claudeTokens';
import { useThemeAccent } from '@/shared/styles/ThemeContext';
import type { ProviderIdentity } from '../onboardingV3Api';
import BeatShell, { ONBOARDING_SANS } from './BeatShell';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const EPITHETS = [
  'METHODICAL PERFECTIONIST', 'SAVORY ARCHIVIST', 'MIDNIGHT ORCHESTRATOR', 'GENTLE MAXIMALIST',
  'PRACTICAL DREAMER', 'QUIET POWER USER', 'CURIOUS CARTOGRAPHER', 'SWARM WHISPERER',
  'DELIBERATE TINKERER', 'WARM SYSTEMATIZER', 'PATIENT ACCELERATIONIST', 'ANALOG FUTURIST',
];

function nameFromIdentity(identity: ProviderIdentity[]): string {
  const email = identity.find((p) => p.email)?.email ?? '';
  const local = email.split('@')[0] ?? '';
  const letters = local.replace(/[^a-zA-Z]/g, '');
  if (!letters) return '';
  return letters.charAt(0).toUpperCase() + letters.slice(1, 12);
}

// The card's leaf takes the two ends of the user's picked theme gradient (or a dark->light pair
// derived from the single accent), so the artifact literally wears the theme they just chose.
function leafStops(gradient: string[] | null, base: string, c: ClaudeTokens): [string, string] {
  if (gradient && gradient.length >= 2) return [gradient[0], gradient[gradient.length - 1]];
  const hsl = hexToHsl(base);
  if (!hsl) return [c.accent.pressed, c.accent.primary];
  const dark = hslToHex({ h: hsl.h, s: Math.min(1, hsl.s * 1.02), l: Math.max(0.34, hsl.l - 0.1) });
  const light = hslToHex({ h: (hsl.h + 0.015) % 1, s: Math.max(0.55, hsl.s * 0.92), l: Math.min(0.74, hsl.l + 0.18) });
  return [dark, light];
}

// One accent-hued ink dark enough to read on the cream card, for every bit of card type.
function readableInk(base: string, c: ClaudeTokens): string {
  const hsl = hexToHsl(base);
  if (!hsl) return c.accent.pressed;
  return hslToHex({ h: hsl.h, s: Math.max(0.5, hsl.s), l: Math.min(0.42, hsl.l) });
}

// The Arc Card moment: onboarding ends with an identity artifact, not a settings screen. A gradient
// leaf wearing the picked theme, the name + a re-rollable epithet, and a real PNG you can save,
// copy, or share, an artifact you show off has to be takeable.
const BeatCard: React.FC<{
  c: ClaudeTokens;
  identity: ProviderIdentity[];
  onFinish: (name: string | null) => void;
  onBack: () => void;
}> = ({ c, identity, onFinish, onBack }) => {
  const { accent, gradient } = useThemeAccent();
  const [name, setName] = useState(() => nameFromIdentity(identity));
  const seed = useMemo(() => Math.floor(Math.random() * EPITHETS.length), []);
  const [roll, setRoll] = useState(0);
  const epithet = EPITHETS[(seed + roll) % EPITHETS.length];
  const today = useMemo(() => new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), []);
  const [tilt, setTilt] = useState<{ rx: number; ry: number; mx: number; my: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const baseHex = (gradient && gradient[0]) || accent || c.accent.primary;
  const [dark, light] = leafStops(gradient, baseHex, c);
  const ink = readableInk(baseHex, c);

  const drawCard = useCallback(async (): Promise<HTMLCanvasElement> => {
    const W = 580;
    const H = 800;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    ctx.fillStyle = '#FCFBF5';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 36);
    ctx.fill();
    // The leaf: three round corners + one soft point at bottom-right, wearing the theme gradient.
    const grad = ctx.createLinearGradient(48, 44, 532, 400);
    grad.addColorStop(0, dark);
    grad.addColorStop(1, light);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(48, 44, W - 96, 340, [150, 150, 12, 150]);
    ctx.fill();
    // Small brand mark in the corner, tinted with the same gradient (source-in keeps the octopus alpha).
    const logo = new Image();
    logo.src = './logo.png';
    await new Promise<void>((res) => { logo.onload = () => res(); logo.onerror = () => res(); });
    if (logo.naturalWidth > 0) {
      const lc = document.createElement('canvas');
      lc.width = 72;
      lc.height = 72;
      const lctx = lc.getContext('2d');
      if (lctx) {
        lctx.drawImage(logo, 0, 0, 72, 72);
        lctx.globalCompositeOperation = 'source-in';
        const lg = lctx.createLinearGradient(0, 0, 72, 72);
        lg.addColorStop(0, dark);
        lg.addColorStop(1, light);
        lctx.fillStyle = lg;
        lctx.fillRect(0, 0, 72, 72);
        ctx.drawImage(lc, 34, 30, 42, 42);
      }
    }
    ctx.fillStyle = ink;
    ctx.font = `800 58px ${ONBOARDING_SANS}`;
    ctx.fillText(name.trim() || 'Your name', 52, 476);
    ctx.font = `600 21px ${MONO}`;
    ctx.fillText(epithet.split('').join(' '), 54, 520);
    // Bottom-left stamp: OPENSWARM | hatch | date, outlined; bottom-right OPEN / SWARM lockup.
    const stampText = `OPENSWARM     ${today.toUpperCase()}`;
    ctx.font = `600 18px ${MONO}`;
    const stampW = ctx.measureText(stampText).width + 30;
    ctx.strokeStyle = `${ink}88`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(48, H - 96, stampW, 42, 8);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fillText(stampText, 63, H - 68);
    ctx.textAlign = 'right';
    ctx.font = `800 19px ${ONBOARDING_SANS}`;
    ctx.fillText('OPEN', W - 48, H - 84);
    ctx.fillText('SWARM', W - 48, H - 62);
    ctx.textAlign = 'left';
    return cv;
  }, [name, epithet, today, dark, light, ink]);

  const saveCard = useCallback(() => {
    void drawCard().then((cv) => {
      const a = document.createElement('a');
      a.download = 'swarm-card.png';
      a.href = cv.toDataURL('image/png');
      a.click();
    });
  }, [drawCard]);

  const copyCard = useCallback(() => {
    void drawCard().then((cv) => {
      cv.toBlob((blob) => {
        if (!blob || !navigator.clipboard || typeof ClipboardItem === 'undefined') return;
        void navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      });
    });
  }, [drawCard]);

  // Native share sheet when the platform offers one (Arc's first card action); quietly absent otherwise.
  const canShare = typeof navigator.canShare === 'function' && typeof File !== 'undefined'
    && navigator.canShare({ files: [new File([''], 'swarm-card.png', { type: 'image/png' })] });
  const shareCard = useCallback(() => {
    void drawCard().then((cv) => {
      cv.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], 'swarm-card.png', { type: 'image/png' });
        void navigator.share({ files: [file], title: 'My Swarm Card' }).catch(() => {});
      });
    });
  }, [drawCard]);

  // Arc's card actions: quiet icon-only buttons under the card on the dark stage.
  const chip = (label: string, Icon: typeof Dices, onClick: () => void): React.ReactElement => (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34,
        border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.62)',
        cursor: 'pointer', borderRadius: 8, transition: 'color 140ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.95)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.62)'; }}
    >
      <Icon size={17} />
    </button>
  );

  return (
    <BeatShell
      c={c}
      title={name ? `Welcome to OpenSwarm, ${name}` : 'Welcome to OpenSwarm'}
      body={"Here's your Swarm Card. Show it off to the world or keep it to yourself.\n\nAnd with that, you're ready to run your new OS."}
      nextLabel="Get started"
      onNext={() => onFinish(name.trim() || null)}
      onBack={onBack}
      stageDark
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, perspective: 900 }}>
        <motion.div
          initial={{ opacity: 0, y: 22, rotate: -3, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 22, delay: 0.25 }}
        >
          <div
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const px = (e.clientX - r.left) / r.width;
              const py = (e.clientY - r.top) / r.height;
              setTilt({ rx: -(py - 0.5) * 13, ry: (px - 0.5) * 13, mx: px * 100, my: py * 100 });
            }}
            onMouseLeave={() => setTilt(null)}
            style={{
              width: 300, height: 414, borderRadius: 18, background: '#FCFBF5',
              border: '1px solid rgba(0,0,0,0.05)',
              boxShadow: tilt ? '0 30px 70px rgba(0,0,0,0.34)' : '0 24px 60px rgba(0,0,0,0.28)',
              padding: '22px 22px 20px', boxSizing: 'border-box',
              display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden',
              transform: tilt ? `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)` : 'rotateX(0deg) rotateY(0deg)',
              transition: tilt ? 'box-shadow 200ms ease' : 'transform 320ms ease, box-shadow 200ms ease',
              willChange: 'transform',
            }}
          >
            {/* Cursor-following shine, the ProfileCard glare. */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none', opacity: tilt ? 1 : 0, transition: 'opacity 250ms ease',
              background: tilt ? `radial-gradient(280px circle at ${tilt.mx}% ${tilt.my}%, rgba(255,255,255,0.45), transparent 62%)` : undefined,
            }} />
            {/* Small brand mark in the corner, wearing the same theme gradient (masked octopus). */}
            <div style={{
              position: 'absolute', top: 14, left: 16, width: 22, height: 22, zIndex: 3,
              WebkitMaskImage: 'url(./logo.png)', maskImage: 'url(./logo.png)',
              WebkitMaskSize: 'contain', maskSize: 'contain',
              WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center', maskPosition: 'center',
              background: `linear-gradient(138deg, ${dark}, ${light})`,
            }} />
            {/* The leaf: three round corners + one soft point, bottom-right, wearing the theme gradient. */}
            <div style={{
              width: '100%', height: 152, flexShrink: 0,
              borderRadius: '47% 47% 8px 47%',
              background: `linear-gradient(138deg, ${dark} 0%, ${light} 100%)`,
            }} />
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 18))}
              placeholder="Your name"
              style={{
                marginTop: 20, border: 'none', outline: 'none', background: 'transparent',
                fontSize: '1.75rem', fontWeight: 800, color: ink, fontFamily: 'inherit',
                width: '100%', padding: 0,
              }}
            />
            <div style={{ marginTop: 5, fontFamily: MONO, fontSize: '0.6875rem', letterSpacing: '0.14em', color: ink }}>
              {epithet}
            </div>
            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                fontFamily: MONO, fontSize: '0.625rem', letterSpacing: '0.08em',
                color: ink, border: `1px solid ${ink}55`, borderRadius: 5, padding: '3px 7px',
              }}>
                OPENSWARM
                <span style={{
                  width: 11, height: 13, borderRadius: 1,
                  background: `repeating-linear-gradient(45deg, ${ink} 0 1.6px, transparent 1.6px 3.6px)`,
                }} />
                {today.toUpperCase()}
              </span>
              <span style={{ fontSize: '0.625rem', letterSpacing: '0.06em', color: ink, fontWeight: 800, textAlign: 'right', lineHeight: 1.35 }}>
                OPEN<br />SWARM
              </span>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }} style={{ display: 'flex', gap: 6 }}>
          {chip('Re-roll the title', Dices, () => setRoll((r) => r + 1))}
          {canShare && chip('Share', Share, shareCard)}
          {chip('Save as image', Download, saveCard)}
          {chip(copied ? 'Copied' : 'Copy to clipboard', copied ? Check : Copy, copyCard)}
        </motion.div>
      </div>
    </BeatShell>
  );
};

export default BeatCard;
