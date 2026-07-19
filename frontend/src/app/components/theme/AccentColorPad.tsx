import React, { useCallback, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { hexToHsl, hslToHex } from '@/shared/styles/claudeTokens';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { Knob, SquiggleSlider } from './WashDials';

export const ACCENT_PRESETS = [
  '#ae5630', '#b0453c', '#8e5cb8', '#3a6fc4', '#2e8f6f', '#b08b2e', '#c2588f', '#5c6470',
  '#e8b4b8', '#f2d0a4', '#a8d8b9', '#9ec5e8', '#c3aed6', '#f7e8a4', '#87d1c6', '#d98cb3',
];
const PRESETS_PER_PAGE = 8;
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
  const [presetPage, setPresetPage] = useState(0);
  const presetPages = Math.ceil(ACCENT_PRESETS.length / PRESETS_PER_PAGE);

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
          // Arc's pad: dark dot-grid field with the spectrum only ghosting through, the picked dots carry the color.
          position: 'relative', height, borderRadius: c.radius.lg, cursor: 'crosshair',
          border: `1px solid ${c.border.medium}`, touchAction: 'none',
          background: [
            'radial-gradient(rgba(255,255,255,0.13) 1px, transparent 1.4px)',
            'linear-gradient(rgba(30,29,27,0.84), rgba(30,29,27,0.84))',
            'linear-gradient(to bottom, rgba(255,255,255,0.55), rgba(0,0,0,0.45))',
            'linear-gradient(to right, hsl(0,72%,55%), hsl(60,72%,55%), hsl(120,72%,55%), hsl(180,72%,55%), hsl(240,72%,55%), hsl(300,72%,55%), hsl(360,72%,55%))',
          ].join(', '),
          backgroundSize: '14px 14px, auto, auto, auto',
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
      {/* Arc's preset carousel: a page of dots between chevrons. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button
          onClick={() => setPresetPage((p) => Math.max(0, p - 1))}
          disabled={presetPage === 0}
          style={{ border: 'none', background: 'transparent', padding: 0, cursor: presetPage === 0 ? 'default' : 'pointer', color: c.text.tertiary, opacity: presetPage === 0 ? 0.35 : 1, display: 'flex' }}
        >
          <ChevronLeft size={15} />
        </button>
        {ACCENT_PRESETS.slice(presetPage * PRESETS_PER_PAGE, (presetPage + 1) * PRESETS_PER_PAGE).map((hex) => (
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
          onClick={() => setPresetPage((p) => Math.min(presetPages - 1, p + 1))}
          disabled={presetPage >= presetPages - 1}
          style={{ border: 'none', background: 'transparent', padding: 0, cursor: presetPage >= presetPages - 1 ? 'default' : 'pointer', color: c.text.tertiary, opacity: presetPage >= presetPages - 1 ? 0.35 : 1, display: 'flex' }}
        >
          <ChevronRight size={15} />
        </button>
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
      {/* Arc's dials row: wavy line = grain, round knob = intensity. */}
      {wash && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, color: c.text.tertiary }}>
          <SquiggleSlider value={wash.grain} onChange={wash.onGrain} width={190} />
          <Knob value={wash.opacity} onChange={wash.onOpacity} />
        </div>
      )}
    </div>
  );
};

export default AccentColorPad;
