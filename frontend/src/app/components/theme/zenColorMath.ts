import { hexToHsl, hslToHex } from '@/shared/styles/claudeTokens';

// Zen Browser's gradient picker math, ported value-for-value from ZenGradientGenerator.mjs
// (MPL-2.0): hue = angle around the pad center, lightness = distance (black center, white rim),
// saturation pinned 90-100. Secondary dots are never free: they sit at the primary's radius with
// hues offset by the active color harmony. One deviation from Zen: coordinates are normalized to an
// ELLIPSE fitting the pad rect, because our pads are wide strips, not Zen's square, and a strict
// inscribed circle left most of the surface dead.

export const HARMONIES: Record<string, number[]> = {
  floating: [],
  singleAnalogous: [310],
  complementary: [180],
  splitComplementary: [150, 210],
  analogous: [50, 310],
  triadic: [120, 240],
};

// Zen's promote ladder: adding a dot moves down this list, removing moves up (mjs:803-811).
export const HARMONY_BY_COUNT: Record<number, string[]> = {
  1: ['floating'],
  2: ['singleAnalogous', 'complementary'],
  3: ['analogous', 'splitComplementary', 'triadic'],
};

export interface PadPoint { x: number; y: number }
export interface PadGeom { cx: number; cy: number; rx: number; ry: number }

function toPolar(x: number, y: number, g: PadGeom): { angle: number; dist: number } {
  const nx = (x - g.cx) / g.rx;
  const ny = (y - g.cy) / g.ry;
  let angle = (Math.atan2(ny, nx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { angle, dist: Math.min(Math.hypot(nx, ny), 1) };
}

function fromPolar(angle: number, dist: number, g: PadGeom): PadPoint {
  const rad = (angle * Math.PI) / 180;
  return { x: g.cx + Math.cos(rad) * dist * g.rx, y: g.cy + Math.sin(rad) * dist * g.ry };
}

export function clampToPad(x: number, y: number, g: PadGeom): PadPoint {
  const p = toPolar(x, y, g);
  return fromPolar(p.angle, p.dist, g);
}

/** Position to color, Zen's default drag type (mjs:532-576): dist 0 = black, 1 = white, sat 90-100. */
export function posToHex(x: number, y: number, g: PadGeom): string {
  const { angle, dist } = toPolar(x, y, g);
  return hslToHex({ h: angle / 360, s: (90 + dist * 10) / 100, l: dist });
}

/** Inverse mapping for a stored stop: hue picks the angle, lightness picks the radius. */
export function hexToPos(hex: string, g: PadGeom): PadPoint {
  const hsl = hexToHsl(hex);
  if (!hsl) return { x: g.cx, y: g.cy };
  return fromPolar(hsl.h * 360, Math.min(1, Math.max(0, hsl.l)), g);
}

/** Secondary dot positions: same radius as the primary, hue offset by the harmony (mjs:875-889). */
export function harmonyPositions(primary: PadPoint, g: PadGeom, harmony: string): PadPoint[] {
  const base = toPolar(primary.x, primary.y, g);
  return (HARMONIES[harmony] ?? []).map((offset) => fromPolar((base.angle + offset) % 360, base.dist, g));
}
