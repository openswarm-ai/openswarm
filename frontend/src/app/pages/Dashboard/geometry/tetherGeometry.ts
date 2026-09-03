import type { Rect, Side, Anchor, Routed } from './tetherTypes';

export type { Rect, Side, Anchor, Routed } from './tetherTypes';

const ELBOW_RADIUS = 16;
// Screen pixels, divided by the committed zoom so the head and the label hold their size at any
// camera; the line itself uses a non-scaling stroke in the layer.
export const HEAD_PX = 9;
export const LABEL_FONT_PX = 11;
// Below this a label would be under 5px tall; the line still shows where the link goes.
export const LABEL_MIN_ZOOM = 0.4;
// A lone line leaves an edge at the historical 54% spot; several share the band below so they
// never stack on top of each other for their first segment.
export const SINGLE_AT = 0.54;
const FAN_FROM = 0.4;
const FAN_TO = 0.72;

export function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * The pair of FACING edges. The axis with the wider gap between the two cards decides, so a line
 * always leaves perpendicular to one card and enters perpendicular to the other, and can never
 * loop back across the card it started from (the nearest-anchor search could pair a right edge
 * with a top edge and then drive a horizontal segment sideways into that top edge).
 */
export function pickSides(src: Rect, dst: Rect): { src: Side; dst: Side } {
  const sc = center(src);
  const dc = center(dst);
  const dx = dc.x - sc.x;
  const dy = dc.y - sc.y;
  const gapX = dx >= 0 ? dst.x - (src.x + src.width) : src.x - (dst.x + dst.width);
  const gapY = dy >= 0 ? dst.y - (src.y + src.height) : src.y - (dst.y + dst.height);
  if (gapX >= gapY) return dx >= 0 ? { src: 'right', dst: 'left' } : { src: 'left', dst: 'right' };
  return dy >= 0 ? { src: 'bottom', dst: 'top' } : { src: 'top', dst: 'bottom' };
}

export function anchorAt(r: Rect, side: Side, fraction: number): Anchor {
  switch (side) {
    case 'left': return { x: r.x, y: r.y + r.height * fraction, side };
    case 'right': return { x: r.x + r.width, y: r.y + r.height * fraction, side };
    case 'top': return { x: r.x + r.width * fraction, y: r.y, side };
    default: return { x: r.x + r.width * fraction, y: r.y + r.height, side };
  }
}

/** Where along an edge each of n lines leaves it: one line at the middle spot, several spread across the band. */
export function fanFractions(n: number): number[] {
  if (n <= 1) return [SINGLE_AT];
  return Array.from({ length: n }, (_, i) => FAN_FROM + ((FAN_TO - FAN_FROM) * i) / (n - 1));
}

/** Left/right pairs: out, across, in. Rounded at both bends. */
export function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const midX = x1 + dx / 2;
  const r = (Math.abs(dy) < 1 || Math.abs(dx) < ELBOW_RADIUS * 2)
    ? 0
    : Math.min(ELBOW_RADIUS, Math.abs(dy) / 2, Math.abs(dx) / 4);
  const sy = dy >= 0 ? 1 : -1;
  const sx = dx >= 0 ? 1 : -1;
  return [
    `M ${x1},${y1}`,
    `H ${midX - sx * r}`,
    `Q ${midX},${y1} ${midX},${y1 + sy * r}`,
    `V ${y2 - sy * r}`,
    `Q ${midX},${y2} ${midX + sx * r},${y2}`,
    `H ${x2}`,
  ].join(' ');
}

/** Top/bottom pairs: the same elbow turned on its side. */
export function verticalElbowPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const midY = y1 + dy / 2;
  const r = (Math.abs(dx) < 1 || Math.abs(dy) < ELBOW_RADIUS * 2)
    ? 0
    : Math.min(ELBOW_RADIUS, Math.abs(dx) / 2, Math.abs(dy) / 4);
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  return [
    `M ${x1},${y1}`,
    `V ${midY - sy * r}`,
    `Q ${x1},${midY} ${x1 + sx * r},${midY}`,
    `H ${x2 - sx * r}`,
    `Q ${x2},${midY} ${x2},${midY + sy * r}`,
    `V ${y2}`,
  ].join(' ');
}

/** Unit direction the line travels as it enters a card through `side`. */
function entryDirection(side: Side): { x: number; y: number } {
  switch (side) {
    case 'left': return { x: 1, y: 0 };
    case 'right': return { x: -1, y: 0 };
    case 'top': return { x: 0, y: 1 };
    default: return { x: 0, y: -1 };
  }
}

/** A filled triangle whose tip sits on the card edge, pointing the way the line travels. */
export function headPath(tip: Anchor, size: number): string {
  const d = entryDirection(tip.side);
  const bx = tip.x - d.x * size;
  const by = tip.y - d.y * size;
  const px = -d.y * size * 0.5;
  const py = d.x * size * 0.5;
  return `M ${tip.x},${tip.y} L ${bx + px},${by + py} L ${bx - px},${by - py} Z`;
}

/** The line stops short of the tip so the stroke never pokes through the head. */
export function route(a: Anchor, b: Anchor, headSize: number): Routed {
  const d = entryDirection(b.side);
  const shorten = headSize * 0.7;
  const ex = b.x - d.x * shorten;
  const ey = b.y - d.y * shorten;
  const horizontal = a.side === 'left' || a.side === 'right';
  const path = horizontal ? elbowPath(a.x, a.y, ex, ey) : verticalElbowPath(a.x, a.y, ex, ey);
  return {
    path,
    head: headPath(b, headSize),
    labelX: a.x + (b.x - a.x) / 2,
    labelY: a.y + (b.y - a.y) / 2,
  };
}

