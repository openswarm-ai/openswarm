import React, { useCallback, useRef, useState } from 'react';
import { RESIZE_HANDLE_DEFS, RESIZE_CURSOR, type ResizeDir } from './cardResizeHandles';




export interface CanvasWindowResizeHandle {
  dir: string;
  style: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}

export interface CanvasWindowResizeState {
  isResizing: boolean;
  /** Live geometry while the pointer is down; null once committed to the slice. */
  live: { x: number; y: number; w: number; h: number } | null;
  handles: CanvasWindowResizeHandle[];
}

interface CanvasWindowResizeArgs {
  cardX: number; cardY: number; cardWidth: number; cardHeight: number;
  minWidth: number; minHeight: number;
  getCanvasState: () => { panX: number; panY: number; zoom: number };
  onCommitPosition: (x: number, y: number) => void;
  onCommitSize: (width: number, height: number) => void;
  /** Tiling rule 5: grabbing a grip breaks the tile and resizes from the rect the card was filling. */
  untileForResize?: () => { x: number; y: number; w: number; h: number } | null;
}

/** The 8 edge/corner grips of a canvas window: preview the new rect locally, commit it on release. */
export function useCanvasWindowResize({
  cardX, cardY, cardWidth, cardHeight, minWidth, minHeight,
  getCanvasState, onCommitPosition, onCommitSize, untileForResize,
}: CanvasWindowResizeArgs): CanvasWindowResizeState {
  const resizeRef = useRef<{ dir: ResizeDir; sx0: number; sy0: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [live, setLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const onResizeDown = useCallback((dir: ResizeDir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const popped = untileForResize?.() ?? null;
    if (popped) setLive(popped);
    resizeRef.current = {
      dir, sx0: e.clientX, sy0: e.clientY,
      ox: popped?.x ?? cardX, oy: popped?.y ?? cardY, ow: popped?.w ?? cardWidth, oh: popped?.h ?? cardHeight,
    };
    setIsResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [cardX, cardY, cardWidth, cardHeight, untileForResize]);

  const compute = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return null;
    const { dir, sx0, sy0, ox, oy, ow, oh } = resizeRef.current;
    const zoom = getCanvasState().zoom;
    const dx = (e.clientX - sx0) / zoom;
    const dy = (e.clientY - sy0) / zoom;
    let nx = ox, ny = oy, nw = ow, nh = oh;
    if (dir.includes('e')) nw = ow + dx;
    if (dir.includes('w')) { nw = ow - dx; nx = ox + dx; }
    if (dir.includes('s')) nh = oh + dy;
    if (dir.includes('n')) { nh = oh - dy; ny = oy + dy; }
    if (nw < minWidth) { if (dir.includes('w')) nx = ox + ow - minWidth; nw = minWidth; }
    if (nh < minHeight) { if (dir.includes('n')) ny = oy + oh - minHeight; nh = minHeight; }
    return { x: nx, y: ny, w: nw, h: nh };
  }, [getCanvasState, minWidth, minHeight]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = compute(e);
    if (r) setLive(r);
  }, [compute]);

  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = compute(e);
    if (r) {
      onCommitPosition(r.x, r.y);
      onCommitSize(r.w, r.h);
    }
    resizeRef.current = null;
    setLive(null);
    setIsResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, [compute, onCommitPosition, onCommitSize]);

  const handles = RESIZE_HANDLE_DEFS.map(({ dir, css }) => ({
    dir,
    style: { position: 'absolute' as const, cursor: RESIZE_CURSOR[dir], zIndex: 25, ...css },
    onPointerDown: onResizeDown(dir),
    onPointerMove: onResizeMove,
    onPointerUp: onResizeUp,
  }));

  return { isResizing, live, handles };
}
