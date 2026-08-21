import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RESIZE_HANDLE_DEFS, RESIZE_CURSOR, type ResizeDir } from './cardResizeHandles';

export interface LiveRect { x: number; y: number; w: number; h: number }

export interface CanvasWindowResizeHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onLostPointerCapture: (e: React.PointerEvent) => void;
}

export interface CanvasWindowResizeHandle extends CanvasWindowResizeHandlers {
  dir: ResizeDir;
  style: React.CSSProperties;
}

export interface CanvasWindowResizeState {
  isResizing: boolean;
  /** Live geometry while the pointer is down; null once committed to the slice. */
  live: LiveRect | null;
  handles: CanvasWindowResizeHandle[];
}

interface CanvasWindowResizeArgs {
  cardX: number; cardY: number; cardWidth: number; cardHeight: number;
  minWidth: number; minHeight: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  onCommitPosition: (x: number, y: number) => void;
  onCommitSize: (width: number, height: number) => void;
  /** Tiling rule 5: grabbing a grip breaks the tile and resizes from the rect the card was filling. */
  untileForResize?: () => LiveRect | null;
}

// Same body class the card drag raises: webviews/iframes go pointer-events:none so a grip dragged inward over a browser page still hears its own release.
const GESTURE_SHIELD_CLASS = 'dashboard-marquee-active';

/** The 8 edge/corner grips of a canvas card: preview the new rect locally, commit it on release.
    Every way a gesture can end (release on the grip, release over a webview or outside the window,
    pointercancel, capture lost to a remount, app blur) funnels into one finish that commits the last
    rect; a move with no button held proves the release was missed and finishes too, so a resize can
    never keep tracking the cursor after the hand let go. */
export function useCanvasWindowResize({
  cardX, cardY, cardWidth, cardHeight, minWidth, minHeight,
  getCanvasState, onCommitPosition, onCommitSize, untileForResize,
}: CanvasWindowResizeArgs): CanvasWindowResizeState {
  const resizeRef = useRef<{ dir: ResizeDir; sx0: number; sy0: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const lastRectRef = useRef<LiveRect | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [live, setLive] = useState<LiveRect | null>(null);

  const compute = useCallback((clientX: number, clientY: number): LiveRect | null => {
    if (!resizeRef.current) return null;
    const { dir, sx0, sy0, ox, oy, ow, oh } = resizeRef.current;
    const zoom = getCanvasState().zoom;
    const dx = (clientX - sx0) / zoom;
    const dy = (clientY - sy0) / zoom;
    let nx = ox, ny = oy, nw = ow, nh = oh;
    if (dir.includes('e')) nw = ow + dx;
    if (dir.includes('w')) { nw = ow - dx; nx = ox + dx; }
    if (dir.includes('s')) nh = oh + dy;
    if (dir.includes('n')) { nh = oh - dy; ny = oy + dy; }
    if (nw < minWidth) { if (dir.includes('w')) nx = ox + ow - minWidth; nw = minWidth; }
    if (nh < minHeight) { if (dir.includes('n')) ny = oy + oh - minHeight; nh = minHeight; }
    return { x: nx, y: ny, w: nw, h: nh };
  }, [getCanvasState, minWidth, minHeight]);

  const finish = useCallback(() => {
    if (!resizeRef.current) return;
    const r = lastRectRef.current;
    resizeRef.current = null;
    lastRectRef.current = null;
    setLive(null);
    setIsResizing(false);
    document.body.classList.remove(GESTURE_SHIELD_CLASS);
    if (r) {
      onCommitPosition(r.x, r.y);
      onCommitSize(r.w, r.h);
    }
  }, [onCommitPosition, onCommitSize]);

  const onResizeDown = useCallback((dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const popped = untileForResize?.() ?? null;
    const origin: LiveRect = popped ?? { x: cardX, y: cardY, w: cardWidth, h: cardHeight };
    if (popped) setLive(popped);
    resizeRef.current = { dir, sx0: e.clientX, sy0: e.clientY, ox: origin.x, oy: origin.y, ow: origin.w, oh: origin.h };
    lastRectRef.current = origin;
    setIsResizing(true);
    document.body.classList.add(GESTURE_SHIELD_CLASS);
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone; the window backstops end it */ }
  }, [cardX, cardY, cardWidth, cardHeight, untileForResize]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    if (e.buttons === 0) { finish(); return; }
    const r = compute(e.clientX, e.clientY);
    if (r) { lastRectRef.current = r; setLive(r); }
  }, [compute, finish]);

  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = compute(e.clientX, e.clientY);
    if (r) lastRectRef.current = r;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* capture already gone */ }
    finish();
  }, [compute, finish]);

  useEffect(() => {
    if (!isResizing) return undefined;
    // Re-raised here because a re-render mid-gesture re-runs this effect and its cleanup lowers the shield.
    document.body.classList.add(GESTURE_SHIELD_CLASS);
    const onUp = (e: PointerEvent): void => {
      const r = compute(e.clientX, e.clientY);
      if (r) lastRectRef.current = r;
      finish();
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      document.body.classList.remove(GESTURE_SHIELD_CLASS);
    };
  }, [isResizing, compute, finish]);

  const handles = RESIZE_HANDLE_DEFS.map(({ dir, css }) => ({
    dir,
    style: { position: 'absolute' as const, cursor: RESIZE_CURSOR[dir], zIndex: 25, ...css },
    onPointerDown: onResizeDown(dir),
    onPointerMove: onResizeMove,
    onPointerUp: onResizeUp,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  }));

  return { isResizing, live, handles };
}
