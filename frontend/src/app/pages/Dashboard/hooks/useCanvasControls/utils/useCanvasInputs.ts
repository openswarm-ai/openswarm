import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import {
  MIN_ZOOM, MAX_ZOOM, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR,
  CanvasState, clamp, sensitivityToMultiplier, zoomAroundCenter,
} from './helpers';

export function useWheelZoom(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  sensitivityRef: MutableRefObject<number>,
  setState: Dispatch<SetStateAction<CanvasState>>,
): void {
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const isPinchZoom = e.ctrlKey || e.metaKey;

      let target = e.target as HTMLElement | null;
      while (target && target !== el) {
        const style = getComputedStyle(target);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const canScrollY =
          target.scrollHeight > target.clientHeight &&
          (overflowY === 'auto' || overflowY === 'scroll');
        const canScrollX =
          target.scrollWidth > target.clientWidth &&
          (overflowX === 'auto' || overflowX === 'scroll');
        if ((canScrollY || canScrollX) && !isPinchZoom) return;
        target = target.parentElement;
      }

      e.preventDefault();

      if (isPinchZoom) {
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        setState((prev) => {
          const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
          const factor = Math.pow(2, -delta * sensitivityToMultiplier(sensitivityRef.current));
          let newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          if (newZoom > 0.97 && newZoom < 1.03 && (prev.zoom <= 0.97 || prev.zoom >= 1.03)) {
            newZoom = 1.0;
          }
          return zoomAroundCenter(prev, newZoom, cx, cy);
        });
      } else {
        const dx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
        const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        setState((prev) => ({ ...prev, panX: prev.panX - dx, panY: prev.panY - dy }));
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef, sensitivityRef, setState]);
}

export function useKeyboardControls(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  setState: Dispatch<SetStateAction<CanvasState>>,
): { spaceHeld: boolean; cmdHeld: boolean } {
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cmdHeld, setCmdHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        e.code === 'Space' && !e.repeat &&
        !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)
      ) {
        e.preventDefault();
        setSpaceHeld(true);
      }
      if ((e.key === 'Meta' || e.key === 'Control') && !e.repeat) {
        setCmdHeld(true);
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '0') {
          e.preventDefault();
          setState({ panX: 0, panY: 0, zoom: 1 });
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          setState((prev) => {
            const newZoom = clamp(prev.zoom * ZOOM_IN_FACTOR, MIN_ZOOM, MAX_ZOOM);
            const el = viewportRef.current;
            if (!el) return { ...prev, zoom: newZoom };
            const rect = el.getBoundingClientRect();
            return zoomAroundCenter(prev, newZoom, rect.width / 2, rect.height / 2);
          });
        } else if (e.key === '-') {
          e.preventDefault();
          setState((prev) => {
            const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
            const el = viewportRef.current;
            if (!el) return { ...prev, zoom: newZoom };
            const rect = el.getBoundingClientRect();
            return zoomAroundCenter(prev, newZoom, rect.width / 2, rect.height / 2);
          });
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
      if (e.key === 'Meta' || e.key === 'Control') setCmdHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [viewportRef, setState]);

  return { spaceHeld, cmdHeld };
}

export function useMousePan(
  stateRef: MutableRefObject<CanvasState>,
  setState: Dispatch<SetStateAction<CanvasState>>,
): {
  isPanning: boolean;
  handlers: {
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseUp: () => void;
  };
} {
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: stateRef.current.panX,
      panY: stateRef.current.panY,
    };
  }, [stateRef]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    setState((prev) => ({
      ...prev,
      panX: start.panX + dx,
      panY: start.panY + dy,
    }));
  }, [setState]);

  const onMouseUp = useCallback(() => {
    panStartRef.current = null;
    setIsPanning(false);
  }, []);

  useEffect(() => {
    const handleUp = () => {
      if (panStartRef.current) {
        panStartRef.current = null;
        setIsPanning(false);
      }
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, []);

  const handlers = useMemo(
    () => ({ onMouseDown, onMouseMove, onMouseUp }),
    [onMouseDown, onMouseMove, onMouseUp],
  );

  return { isPanning, handlers };
}
