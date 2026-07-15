import React, { useCallback, useRef } from 'react';
import { Minus, Plus } from 'lucide-react';
import { hexToHsl, hslToHex } from '@/shared/styles/claudeTokens';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

export const ACCENT_PRESETS = ['#ae5630', '#b0453c', '#8e5cb8', '#3a6fc4', '#2e8f6f', '#b08b2e', '#c2588f', '#5c6470'];
const MAX_STOPS = 3;

function stopToXY(hex: string): { x: number; y: number } | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  return { x: hsl.h, y: Math.min(1, Math.max(0, (0.62 - hsl.l) / 0.34)) };
}

export interface WashControls {
  opacity: number;
  grain: number;
  onOpacity: (v: number) => void;
  onGrain: (v: number) => void;
}

// Arc/Zen gradient engine, one control with two homes: 1-3 draggable stops on a hue/lightness field, + adds a color-theory-harmonized stop (analogous, then triadic), - removes the newest. The first stop is the accent the tokens derive from; 2+ stops become the canvas gradient wash, whose intensity + grain the optional sliders tune. The pad reports stops and never knows who is listening.
const AccentColorPad: React.FC<{
  c: ClaudeTokens;
  stops: string[];
  onChange: (stops: string[] | null) => void;
  height?: number;
  wash?: WashControls;
}> = ({ c, stops, onChange, height = 240, wash }) => {
  const padRef = useRef<HTMLDivElement | null>(null);
  const grabbedRef = useRef<number | null>(null);
  const lastApplyRef = useRef(0);

  const pointToHex = useCallback((clientX: number, clientY: number): string | null => {
    const pad = padRef.current;
    if (!pad) return null;
    const rect = pad.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return hslToHex({ h: fx, s: 0.72, l: 0.62 - fy * 0.34 });
  }, []);

  const nearestStop = useCallback((clientX: number, clientY: number): number => {
    const pad = padRef.current;
    if (!pad || stops.length === 0) return 0;
    const rect = pad.getBoundingClientRect();
    let best = 0;
    let bestDist = Infinity;
    stops.forEach((hex, i) => {
      const xy = stopToXY(hex);
      if (!xy) return;
      const dx = rect.left + xy.x * rect.width - clientX;
      const dy = rect.top + xy.y * rect.height - clientY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }, [stops]);

  const applyAt = useCallback((clientX: number, clientY: number) => {
    // ~30ms throttle: a live listener re-derives tokens and re-renders the tree per apply.
    const now = performance.now();
    if (now - lastApplyRef.current < 30) return;
    lastApplyRef.current = now;
    const hex = pointToHex(clientX, clientY);
    if (!hex) return;
    const idx = grabbedRef.current ?? 0;
    const next = stops.length === 0 ? [hex] : stops.map((s, i) => (i === idx ? hex : s));
    onChange(next);
  }, [pointToHex, stops, onChange]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    grabbedRef.current = nearestStop(e.clientX, e.clientY);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    lastApplyRef.current = 0;
    applyAt(e.clientX, e.clientY);
  }, [nearestStop, applyAt]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (grabbedRef.current !== null) applyAt(e.clientX, e.clientY);
  }, [applyAt]);

  const onPointerUp = useCallback(() => { grabbedRef.current = null; }, []);

  const addStop = useCallback(() => {
    if (stops.length >= MAX_STOPS) return;
    // Color-theory harmony off the FIRST stop: 2nd = analogous (+30deg), 3rd = triadic (+120deg).
    const anchor = hexToHsl(stops[0] ?? ACCENT_PRESETS[0]);
    const h0 = anchor?.h ?? 0.08;
    const hue = (h0 + (stops.length === 1 ? 0.083 : 0.333)) % 1;
    onChange([...stops, hslToHex({ h: hue, s: anchor?.s ?? 0.72, l: anchor?.l ?? 0.5 })]);
  }, [stops, onChange]);

  const removeStop = useCallback(() => {
    if (stops.length <= 1) return;
    onChange(stops.slice(0, -1));
  }, [stops, onChange]);

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
        {stops.map((hex, i) => {
          const xy = stopToXY(hex);
          if (!xy) return null;
          return (
            <span key={i} style={{
              position: 'absolute', left: `${xy.x * 100}%`, top: `${xy.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: i === 0 ? 28 : 22, height: i === 0 ? 28 : 22,
              borderRadius: 999, background: hex,
              border: '3px solid #fff', boxShadow: '0 2px 8px rgba(0,0,0,0.35)', pointerEvents: 'none',
            }} />
          );
        })}
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6 }}
        >
          <button
            onClick={removeStop}
            disabled={stops.length <= 1}
            style={{
              width: 26, height: 22, borderRadius: 7, border: 'none', cursor: stops.length > 1 ? 'pointer' : 'default',
              background: 'rgba(20,20,19,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: stops.length > 1 ? 1 : 0.4,
            }}
          >
            <Minus size={13} />
          </button>
          <button
            onClick={addStop}
            disabled={stops.length >= MAX_STOPS}
            style={{
              width: 26, height: 22, borderRadius: 7, border: 'none', cursor: stops.length < MAX_STOPS ? 'pointer' : 'default',
              background: 'rgba(20,20,19,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: stops.length < MAX_STOPS ? 1 : 0.4,
            }}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        {ACCENT_PRESETS.map((hex) => (
          <button
            key={hex}
            onClick={() => onChange([hex])}
            style={{
              width: 26, height: 26, borderRadius: 999, background: hex, cursor: 'pointer',
              border: stops[0] === hex && stops.length === 1 ? '2.5px solid #fff' : '2.5px solid transparent',
              boxShadow: stops[0] === hex && stops.length === 1 ? `0 0 0 2px ${hex}` : 'none', padding: 0,
            }}
          />
        ))}
        <button
          onClick={() => onChange(null)}
          style={{
            marginLeft: 'auto', border: 'none', background: 'transparent', padding: 0,
            color: '#8a8a86', fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
          }}
        >
          Reset
        </button>
      </div>
      {wash && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.78rem', color: c.text.tertiary }}>
            <span style={{ width: 52, flexShrink: 0 }}>Intensity</span>
            <input type="range" min={0} max={1} step={0.01} value={wash.opacity} onChange={(e) => wash.onOpacity(parseFloat(e.target.value))} style={{ flex: 1, accentColor: c.accent.primary }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.78rem', color: c.text.tertiary }}>
            <span style={{ width: 52, flexShrink: 0 }}>Grain</span>
            <input type="range" min={0} max={1} step={0.01} value={wash.grain} onChange={(e) => wash.onGrain(parseFloat(e.target.value))} style={{ flex: 1, accentColor: c.accent.primary }} />
          </label>
        </div>
      )}
    </div>
  );
};

export default AccentColorPad;
