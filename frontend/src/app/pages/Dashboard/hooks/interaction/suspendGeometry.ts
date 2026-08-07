import type { BrowserCardPosition } from '@/shared/state/dashboardLayoutSlice';

export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
  vpW: number;
  vpH: number;
}

export function cardIntersectsViewport(card: BrowserCardPosition, vp: Viewport, marginPx: number): boolean {
  const m = marginPx / vp.zoom;
  const vx = -vp.panX / vp.zoom - m;
  const vy = -vp.panY / vp.zoom - m;
  const vw = vp.vpW / vp.zoom + 2 * m;
  const vh = vp.vpH / vp.zoom + 2 * m;
  return card.x < vx + vw && card.x + card.width > vx && card.y < vy + vh && card.y + card.height > vy;
}

export function distFromCenter(card: BrowserCardPosition, vp: Viewport): number {
  const cx = (-vp.panX + vp.vpW / 2) / vp.zoom;
  const cy = (-vp.panY + vp.vpH / 2) / vp.zoom;
  const dx = card.x + card.width / 2 - cx;
  const dy = card.y + card.height / 2 - cy;
  return dx * dx + dy * dy;
}
