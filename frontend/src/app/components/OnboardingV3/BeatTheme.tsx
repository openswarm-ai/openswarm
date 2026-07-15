import React, { useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { useThemeAccent, useThemeMode } from '@/shared/styles/ThemeContext';
import { hexToHsl, hslToHex } from '@/shared/styles/claudeTokens';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import BeatShell from './BeatShell';

const PRESETS = ['#ae5630', '#b0453c', '#8e5cb8', '#3a6fc4', '#2e8f6f', '#b08b2e', '#c2588f', '#5c6470'];

// The IKEA-effect beat: dragging on the pad drives the REAL app theme live through ThemeContext, so the product becomes theirs before they've entered it. Persistence happens at finish(), not here.
const BeatTheme: React.FC<{
  c: ClaudeTokens;
  onNext: () => void;
  onBack: () => void;
}> = ({ c, onNext, onBack }) => {
  const { accent, setAccent } = useThemeAccent();
  const { mode, setMode } = useThemeMode();
  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const lastApplyRef = useRef(0);

  const applyFromEvent = useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return;
    // ~30ms throttle: every apply re-derives tokens and re-renders the tree, and pointermove fires far faster than paint needs.
    const now = performance.now();
    if (now - lastApplyRef.current < 30) return;
    lastApplyRef.current = now;
    const rect = pad.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    setAccent(hslToHex({ h: fx, s: 0.72, l: 0.62 - fy * 0.34 }));
  }, [setAccent]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    lastApplyRef.current = 0;
    applyFromEvent(e.clientX, e.clientY);
  }, [applyFromEvent]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) applyFromEvent(e.clientX, e.clientY);
  }, [applyFromEvent]);

  const onPointerUp = useCallback(() => { draggingRef.current = false; }, []);

  const dot = accent ? hexToHsl(accent) : null;

  return (
    <BeatShell
      c={c}
      title="Make it yours."
      body="Pick a color, any color. The whole app repaints as you drag; this is your home now."
      nextLabel="Continue"
      onNext={onNext}
      onBack={onBack}
    >
      <div style={{ width: 'min(420px, 100%)', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <motion.div
          ref={padRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          style={{
            position: 'relative', height: 240, borderRadius: c.radius.lg, cursor: 'crosshair',
            border: `1px solid ${c.border.medium}`, touchAction: 'none',
            background: 'linear-gradient(to bottom, rgba(255,255,255,0.55), rgba(0,0,0,0.45)), linear-gradient(to right, hsl(0,72%,55%), hsl(60,72%,55%), hsl(120,72%,55%), hsl(180,72%,55%), hsl(240,72%,55%), hsl(300,72%,55%), hsl(360,72%,55%))',
          }}
        >
          {dot && (
            <span style={{
              position: 'absolute',
              left: `${dot.h * 100}%`,
              top: `${((0.62 - dot.l) / 0.34) * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 26, height: 26, borderRadius: 999, background: accent ?? 'transparent',
              border: '3px solid #fff', boxShadow: '0 2px 8px rgba(0,0,0,0.35)', pointerEvents: 'none',
            }} />
          )}
        </motion.div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          {PRESETS.map((hex) => (
            <button
              key={hex}
              onClick={() => setAccent(hex)}
              style={{
                width: 26, height: 26, borderRadius: 999, background: hex, cursor: 'pointer',
                border: accent === hex ? '2.5px solid #fff' : '2.5px solid transparent',
                boxShadow: accent === hex ? `0 0 0 2px ${hex}` : 'none', padding: 0,
              }}
            />
          ))}
          <button
            onClick={() => setAccent(null)}
            style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', padding: 0,
              color: c.text.ghost, fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
            }}
          >
            Reset
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['light', 'dark'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '11px 0', borderRadius: c.radius.md, fontFamily: 'inherit', fontSize: '0.88rem', fontWeight: 500,
                border: `1.5px solid ${mode === m ? c.accent.primary : c.border.medium}`,
                background: c.bg.surface, color: c.text.secondary, cursor: 'pointer',
                transition: 'border-color 140ms ease',
              }}
            >
              {m === 'light' ? <Sun size={15} /> : <Moon size={15} />}
              {m === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>
    </BeatShell>
  );
};

export default BeatTheme;
