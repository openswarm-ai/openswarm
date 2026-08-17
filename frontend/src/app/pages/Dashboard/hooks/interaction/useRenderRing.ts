import { useEffect, useRef, useState } from 'react';

// Chromium only pre-renders content-visibility:auto elements a sliver past the viewport, so a pan
// always lands on never-drawn cards and pays first-raster right under the gesture (ENG-301's
// 100-700ms singles). Eric's call: keep a RING of canvas around the camera always rendered, so by
// the time you arrive it is already drawn. Cards inside the ring force 'visible'; far cards keep
// 'auto' (that skip is what holds 150-card boards at frame budget, ENG-261). Enter at ENTER_VP
// viewports, leave at LEAVE_VP, so boundary jitter never flips a card back and forth.
const ENTER_VP = 1.5;
const LEAVE_VP = 2.25;
// Newly-near cards render at most this many per frame: a fast pan crossing 30 cards must warm them
// over a few frames, not stall the gesture frame it happens in.
const PROMOTIONS_PER_FRAME = 3;

let p_pending: Array<() => void> = [];
let p_drainScheduled = false;

function p_drain(): void {
  p_drainScheduled = false;
  const batch = p_pending.splice(0, PROMOTIONS_PER_FRAME);
  for (const fn of batch) fn();
  if (p_pending.length > 0) {
    p_drainScheduled = true;
    requestAnimationFrame(p_drain);
  }
}

function p_enqueuePromotion(fn: () => void): void {
  p_pending.push(fn);
  if (!p_drainScheduled) {
    p_drainScheduled = true;
    requestAnimationFrame(p_drain);
  }
}

export function useRenderRing(
  cardX: number,
  cardY: number,
  cardWidth: number,
  cardHeight: number,
  getCanvasState: () => { panX: number; panY: number; zoom: number },
  active: boolean,
): boolean {
  const [near, setNear] = useState(false);
  const nearRef = useRef(false);
  const rectRef = useRef({ x: cardX, y: cardY, w: cardWidth, h: cardHeight });
  rectRef.current = { x: cardX, y: cardY, w: cardWidth, h: cardHeight };

  useEffect(() => {
    // Measurement escape hatch: lets the perf harness A/B ring-on vs ring-off on identical bits.
    if (!active || localStorage.getItem('osw-render-ring') === 'off') return undefined;
    let raf = 0;
    const evaluate = (): void => {
      raf = 0;
      const { panX, panY, zoom } = getCanvasState();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Viewport in canvas coordinates.
      const vx = -panX / zoom;
      const vy = -panY / zoom;
      const vwC = vw / zoom;
      const vhC = vh / zoom;
      const marginVp = nearRef.current ? LEAVE_VP : ENTER_VP;
      const mx = vwC * marginVp;
      const my = vhC * marginVp;
      const r = rectRef.current;
      const isNear =
        r.x + r.w > vx - mx && r.x < vx + vwC + mx &&
        r.y + r.h > vy - my && r.y < vy + vhC + my;
      if (isNear !== nearRef.current) {
        nearRef.current = isNear;
        // Leaving the ring is free (back to skipped); entering pays a render, so it rides the
        // per-frame promotion budget instead of landing all at once mid-gesture.
        if (isNear) p_enqueuePromotion(() => setNear(true));
        else setNear(false);
      }
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(evaluate);
    };
    schedule();
    window.addEventListener('openswarm:canvas-pan-changed', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('openswarm:canvas-pan-changed', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [getCanvasState, active]);

  return near;
}
