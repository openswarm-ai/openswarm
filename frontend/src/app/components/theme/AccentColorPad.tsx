import React, { useCallback, useRef } from 'react';
import { hexToHsl, hslToHex } from '@/shared/styles/claudeTokens';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

export const ACCENT_PRESETS = ['#ae5630', '#b0453c', '#8e5cb8', '#3a6fc4', '#2e8f6f', '#b08b2e', '#c2588f', '#5c6470'];

// One control, two homes: the onboarding theme beat drives the live theme through it, and Settings > Interface edits the saved draft. Hue on x, lightness on y; the pad reports a hex and never knows who is listening.
const AccentColorPad: React.FC<{
  c: ClaudeTokens;
  accent: string | null;
  onPick: (hex: string | null) => void;
  height?: number;
}> = ({ c, accent, onPick, height = 240 }) => {
  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const lastApplyRef = useRef(0);

  const applyFromEvent = useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return;
    // ~30ms throttle: a live listener re-derives tokens and re-renders the tree per apply, and pointermove fires far faster than paint needs.
    const now = performance.now();
    if (now - lastApplyRef.current < 30) return;
    lastApplyRef.current = now;
    const rect = pad.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    onPick(hslToHex({ h: fx, s: 0.72, l: 0.62 - fy * 0.34 }));
  }, [onPick]);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div
        ref={padRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: 'relative', height, borderRadius: c.radius.lg, cursor: 'crosshair',
          border: `1px solid ${c.border.medium}`, touchAction: 'none',
          background: 'linear-gradient(to bottom, rgba(255,255,255,0.55), rgba(0,0,0,0.45)), linear-gradient(to right, hsl(0,72%,55%), hsl(60,72%,55%), hsl(120,72%,55%), hsl(180,72%,55%), hsl(240,72%,55%), hsl(300,72%,55%), hsl(360,72%,55%))',
        }}
      >
        {dot && (
          <span style={{
            position: 'absolute',
            left: `${dot.h * 100}%`,
            top: `${Math.min(100, Math.max(0, ((0.62 - dot.l) / 0.34) * 100))}%`,
            transform: 'translate(-50%, -50%)',
            width: 26, height: 26, borderRadius: 999, background: accent ?? 'transparent',
            border: '3px solid #fff', boxShadow: '0 2px 8px rgba(0,0,0,0.35)', pointerEvents: 'none',
          }} />
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        {ACCENT_PRESETS.map((hex) => (
          <button
            key={hex}
            onClick={() => onPick(hex)}
            style={{
              width: 26, height: 26, borderRadius: 999, background: hex, cursor: 'pointer',
              border: accent === hex ? '2.5px solid #fff' : '2.5px solid transparent',
              boxShadow: accent === hex ? `0 0 0 2px ${hex}` : 'none', padding: 0,
            }}
          />
        ))}
        <button
          onClick={() => onPick(null)}
          style={{
            marginLeft: 'auto', border: 'none', background: 'transparent', padding: 0,
            color: '#8a8a86', fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
};

export default AccentColorPad;
