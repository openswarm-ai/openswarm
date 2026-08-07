import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Monitor, Moon, Plus, Sparkles, Sun } from 'lucide-react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { Knob, SquiggleSlider } from './WashDials';
import { HARMONY_BY_COUNT, clampToPad, harmonyPositions, hexToPos, posToHex, type PadGeom, type PadPoint } from './zenColorMath';

export const ACCENT_PRESETS = [
  '#ae5630', '#b0453c', '#8e5cb8', '#3a6fc4', '#2e8f6f', '#b08b2e', '#c2588f', '#5c6470',
  '#e8b4b8', '#f2d0a4', '#a8d8b9', '#9ec5e8', '#c3aed6', '#f7e8a4', '#87d1c6', '#d98cb3',
];
const PRESETS_PER_PAGE = 8;
const MAX_STOPS = 3;

export interface WashControls {
  opacity: number;
  grain: number;
  onOpacity: (v: number) => void;
  onGrain: (v: number) => void;
}

export interface SchemeControls {
  value: 'light' | 'dark' | 'system';
  onPick: (v: 'light' | 'dark' | 'system') => void;
}

// Zen's picker, both temperaments: every dot drags FREELY (grab any dot, place it anywhere), and the
// sparkle button harmonizes: secondaries snap to color-theory offsets around the primary and follow
// it until a secondary is grabbed again. + adds a harmonized color without disturbing placed dots,
// right-click removes the newest. Scheme trio (light/dark/system) rides the pad like Zen's.
const AccentColorPad: React.FC<{
  c: ClaudeTokens;
  stops: string[];
  onChange: (stops: string[] | null) => void;
  height?: number;
  wash?: WashControls;
  scheme?: SchemeControls;
}> = ({ c, stops, onChange, height = 240, wash, scheme }) => {
  const padRef = useRef<HTMLDivElement | null>(null);
  const grabbedRef = useRef<number | null>(null);
  const lastApplyRef = useRef(0);
  const [presetPage, setPresetPage] = useState(0);
  // Freeform = dots are independent (the old behavior); harmony mode makes secondaries follow the primary.
  const [freeform, setFreeform] = useState(true);
  const [harmonyIdx, setHarmonyIdx] = useState(0);
  const presetPages = Math.ceil(ACCENT_PRESETS.length / PRESETS_PER_PAGE);
  const harmony = (HARMONY_BY_COUNT[stops.length] ?? ['floating'])[harmonyIdx % (HARMONY_BY_COUNT[stops.length]?.length ?? 1)];

  const geometry = useCallback((): { rect: DOMRect; g: PadGeom } | null => {
    const pad = padRef.current;
    if (!pad) return null;
    const rect = pad.getBoundingClientRect();
    const g: PadGeom = { cx: rect.width / 2, cy: rect.height / 2, rx: rect.width / 2 - 18, ry: rect.height / 2 - 18 };
    return { rect, g };
  }, []);

  const dotPositions = useMemo((): PadPoint[] => {
    const g = geometry();
    if (!g || stops.length === 0) return [];
    if (freeform) return stops.map((hex) => hexToPos(hex, g.g));
    const primary = hexToPos(stops[0], g.g);
    return [primary, ...harmonyPositions(primary, g.g, harmony).slice(0, stops.length - 1)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, harmony, freeform, geometry, padRef.current]);

  const applyAt = useCallback((clientX: number, clientY: number) => {
    // ~30ms throttle: a live listener re-derives tokens and re-renders the tree per apply.
    const now = performance.now();
    if (now - lastApplyRef.current < 30) return;
    lastApplyRef.current = now;
    const g = geometry();
    if (!g) return;
    const p = clampToPad(clientX - g.rect.left, clientY - g.rect.top, g.g);
    const hex = posToHex(p.x, p.y, g.g);
    const idx = grabbedRef.current ?? 0;
    if (stops.length === 0) { onChange([hex]); return; }
    if (!freeform && idx === 0) {
      // Harmony mode: the primary drags, the family follows.
      const secondaries = harmonyPositions(p, g.g, harmony).slice(0, stops.length - 1);
      onChange([hex, ...secondaries.map((sp) => posToHex(sp.x, sp.y, g.g))]);
      return;
    }
    onChange(stops.map((s, i) => (i === idx ? hex : s)));
  }, [geometry, stops, freeform, harmony, onChange]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const g = geometry();
    if (!g) return;
    // Grab the nearest dot; grabbing a SECONDARY breaks harmony into freeform (your dot, your spot).
    let best = 0;
    let bestDist = Infinity;
    dotPositions.forEach((p, i) => {
      const dx = g.rect.left + p.x - e.clientX;
      const dy = g.rect.top + p.y - e.clientY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    grabbedRef.current = best;
    if (best > 0 && !freeform) setFreeform(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    lastApplyRef.current = 0;
    applyAt(e.clientX, e.clientY);
  }, [geometry, dotPositions, freeform, applyAt]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (grabbedRef.current !== null) applyAt(e.clientX, e.clientY);
  }, [applyAt]);

  const onPointerUp = useCallback(() => { grabbedRef.current = null; }, []);

  // Zen: right-click removes the newest dot.
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (stops.length <= 1) return;
    onChange(stops.slice(0, -1));
  }, [stops, onChange]);

  const addStop = useCallback(() => {
    if (stops.length >= MAX_STOPS) return;
    const g = geometry();
    if (!g || stops.length === 0) { onChange([...(stops.length ? stops : [ACCENT_PRESETS[0]])]); return; }
    // New color comes from the harmony family of the primary; existing dots stay where they are.
    const primary = hexToPos(stops[0], g.g);
    const family = (HARMONY_BY_COUNT[stops.length + 1] ?? ['floating'])[0];
    const positions = harmonyPositions(primary, g.g, family);
    const next = positions[stops.length - 1] ?? positions[0];
    onChange([...stops, next ? posToHex(next.x, next.y, g.g) : stops[0]]);
  }, [stops, geometry, onChange]);

  const removeStop = useCallback(() => {
    if (stops.length <= 1) return;
    onChange(stops.slice(0, -1));
  }, [stops, onChange]);

  // The sparkle: snap into (or rotate) the color-theory harmony for this dot count.
  const harmonize = useCallback(() => {
    const family = HARMONY_BY_COUNT[stops.length] ?? ['floating'];
    const nextIdx = freeform ? harmonyIdx : (harmonyIdx + 1) % family.length;
    setFreeform(false);
    setHarmonyIdx(nextIdx);
    const g = geometry();
    if (!g || stops.length === 0) return;
    const primary = hexToPos(stops[0], g.g);
    const secondaries = harmonyPositions(primary, g.g, family[nextIdx]).slice(0, stops.length - 1);
    onChange([stops[0], ...secondaries.map((sp) => posToHex(sp.x, sp.y, g.g))]);
  }, [stops, freeform, harmonyIdx, geometry, onChange]);

  const padBtn: React.CSSProperties = {
    width: 30, height: 26, borderRadius: 8, border: 'none',
    background: 'rgba(255,255,255,0.09)', color: 'rgba(255,255,255,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    transition: 'background 120ms ease',
  };

  const SCHEMES: Array<{ key: 'light' | 'dark' | 'system'; Icon: typeof Sun }> = [
    { key: 'light', Icon: Sun }, { key: 'dark', Icon: Moon }, { key: 'system', Icon: Monitor },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div
        ref={padRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        style={{
          // Zen's pad: a dark dotted-grid field; position IS the color, so no painted spectrum.
          position: 'relative', height, borderRadius: c.radius.lg, cursor: 'crosshair',
          border: `1px solid ${c.border.medium}`, touchAction: 'none',
          background: [
            'radial-gradient(rgba(255,255,255,0.16) 1px, transparent 1.4px)',
            'linear-gradient(rgba(24,23,22,0.97), rgba(24,23,22,0.97))',
          ].join(', '),
          backgroundSize: '12px 12px, auto',
        }}
      >
        {scheme && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9, padding: 3 }}
          >
            {SCHEMES.map(({ key, Icon }) => (
              <button
                key={key}
                onClick={() => scheme.onPick(key)}
                title={key.charAt(0).toUpperCase() + key.slice(1)}
                style={{
                  width: 26, height: 22, borderRadius: 6, border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: scheme.value === key ? c.accent.primary : 'transparent',
                  color: scheme.value === key ? '#fff' : 'rgba(255,255,255,0.55)',
                  transition: 'background 140ms ease, color 140ms ease',
                }}
              >
                <Icon size={13} />
              </button>
            ))}
          </div>
        )}
        {dotPositions.map((p, i) => (
          <span key={i} style={{
            position: 'absolute', left: p.x, top: p.y,
            transform: 'translate(-50%, -50%)',
            width: i === 0 ? 28 : 22, height: i === 0 ? 28 : 22,
            borderRadius: 999, background: stops[i],
            border: i === 0 ? '3px solid #fff' : '2px solid rgba(255,255,255,0.75)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)', pointerEvents: 'none',
            transition: grabbedRef.current !== null ? 'none' : 'left 300ms cubic-bezier(0.34,1.4,0.64,1), top 300ms cubic-bezier(0.34,1.4,0.64,1)',
          }} />
        ))}
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9, padding: 3 }}
        >
          <button onClick={removeStop} disabled={stops.length <= 1} title="Remove a color" style={{ ...padBtn, opacity: stops.length <= 1 ? 0.35 : 1, cursor: stops.length <= 1 ? 'default' : 'pointer' }}>
            <Minus size={13} />
          </button>
          <button onClick={addStop} disabled={stops.length >= MAX_STOPS} title="Add a color" style={{ ...padBtn, opacity: stops.length >= MAX_STOPS ? 0.35 : 1, cursor: stops.length >= MAX_STOPS ? 'default' : 'pointer' }}>
            <Plus size={13} />
          </button>
          {stops.length > 1 && (
            <button onClick={harmonize} title="Harmonize: snap the other dots to color theory around your first color" style={{ ...padBtn, ...(freeform ? {} : { background: c.accent.primary, color: '#fff' }) }}>
              <Sparkles size={13} />
            </button>
          )}
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
            onClick={() => { setFreeform(true); onChange([hex]); }}
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
          onClick={() => { setFreeform(true); onChange(null); }}
          style={{
            marginLeft: 'auto', border: 'none', background: 'transparent', padding: 0,
            color: '#8a8a86', fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
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
