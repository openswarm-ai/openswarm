import React from 'react';

// macOS-style tiling zones (fractions of the workspace) + the math to render a tiled card at a
// screen-space viewport region WITHOUT leaving the transformed canvas layer, so a browser/app
// card's webview is never remounted (which would log the user out). The card stays a child of the
// pan/zoom layer; we counter-transform (scale 1/zoom) and place it in canvas coords so it lands
// pixel-exact at the viewport region at 100% content scale. Recompute on pan/zoom to stay put.

export const TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  fill:   { x: 0,     y: 0,   w: 1,     h: 1 },
  left:   { x: 0,     y: 0,   w: 0.5,   h: 1 },
  right:  { x: 0.5,   y: 0,   w: 0.5,   h: 1 },
  top:    { x: 0,     y: 0,   w: 1,     h: 0.5 },
  bottom: { x: 0,     y: 0.5, w: 1,     h: 0.5 },
  tl:     { x: 0,     y: 0,   w: 0.5,   h: 0.5 },
  tr:     { x: 0.5,   y: 0,   w: 0.5,   h: 0.5 },
  bl:     { x: 0,     y: 0.5, w: 0.5,   h: 0.5 },
  br:     { x: 0.5,   y: 0.5, w: 0.5,   h: 0.5 },
  t3l:    { x: 0,     y: 0,   w: 1 / 3, h: 1 },
  t3c:    { x: 1 / 3, y: 0,   w: 1 / 3, h: 1 },
  t3r:    { x: 2 / 3, y: 0,   w: 1 / 3, h: 1 },
};

// macOS Sequoia leaves a small gap between tiled windows; we match it.
const GAP = 8;

export interface TiledStyle {
  left: number;
  top: number;
  width: number;
  height: number;
  transform: string;
  transformOrigin: string;
}

// The workspace = the canvas viewport element (already below the app header, dock floats over it),
// measured live so we never hardcode chrome sizes that drift. Its screen origin cancels out of the
// math below because the card shares the viewport's coordinate system, so we only need its size.
function workspaceSize(): { w: number; h: number } {
  const el = document.querySelector('[data-canvas-viewport]');
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

export function computeTiledStyle(zone: string, panX: number, panY: number, zoom: number): TiledStyle | null {
  // 'fullscreen' = macOS full screen: the app chrome hides (AppShell/DashboardCanvas react to
  // selectFullscreenCardId) and the card covers the window minus a thin PEEK sliver, the Zen/Arc
  // touch where the surroundings stay ever-so-slightly visible. Target is WINDOW space here, so
  // the viewport origin does NOT cancel; once the chrome collapses that origin goes to ~0 anyway.
  if (zone === 'fullscreen') {
    const PEEK = 10;
    const el = document.querySelector('[data-canvas-viewport]');
    const r = el ? el.getBoundingClientRect() : null;
    const ox = r ? r.left : 0;
    const oy = r ? r.top : 0;
    return {
      left: (PEEK - ox - panX) / zoom,
      top: (PEEK - oy - panY) / zoom,
      width: window.innerWidth - PEEK * 2,
      height: window.innerHeight - PEEK * 2,
      transform: `scale(${1 / zoom})`,
      transformOrigin: 'top left',
    };
  }
  const z = TILE_ZONES[zone];
  if (!z) return null;
  const { w: vpW, h: vpH } = workspaceSize();
  // Screen region (vpX + GAP, vpY + GAP, ...) converted to canvas coords: card lives inside the
  // pan/zoom layer, so screen = viewportOrigin + pan + canvasPos*zoom, and viewportOrigin cancels.
  return {
    left: (z.x * vpW + GAP - panX) / zoom,
    top: (z.y * vpH + GAP - panY) / zoom,
    width: z.w * vpW - GAP * 2,
    height: z.h * vpH - GAP * 2,
    transform: `scale(${1 / zoom})`,
    transformOrigin: 'top left',
  };
}

// Tiled geometry depends on live DOM measurements, so re-render when the workspace resizes:
// the chrome collapsing on fullscreen-enter, a window resize, a banner appearing. The initial
// ResizeObserver fire also re-measures right after the same-commit layout change that set the zone.
export function useTiledStyle(zone: string | undefined, panX: number, panY: number, zoom: number): TiledStyle | null {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!zone) return undefined;
    const el = document.querySelector('[data-canvas-viewport]');
    const ro = new ResizeObserver(() => bump());
    if (el) ro.observe(el);
    const onResize = (): void => bump();
    window.addEventListener('resize', onResize);
    // The chrome collapse commits in the same flush that set the zone, so the first compute
    // measures the pre-collapse viewport; re-measure after layout settles. Timeouts, not rAF:
    // rAF (and ResizeObserver delivery, which rides it) freezes in non-focused tabs.
    // 700ms outlives the banner Collapse (350ms) plus easing tail; RO covers focused tabs live.
    const timers = [60, 250, 700].map((ms) => window.setTimeout(() => bump(), ms));
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); timers.forEach((t) => window.clearTimeout(t)); };
  }, [zone]);
  return zone ? computeTiledStyle(zone, panX, panY, zoom) : null;
}
