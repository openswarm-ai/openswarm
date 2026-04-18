import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  MIN_ZOOM, MAX_ZOOM, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR, FIT_PADDING,
  CanvasState, clamp, zoomAroundCenter,
} from './canvasControlsUtils';
import { useWheelZoom, useKeyboardControls, useMousePan } from './useCanvasInputs';

export function useCanvasControls(zoomSensitivity: number = 50) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState<CanvasState>({ panX: 0, panY: 0, zoom: 1 });

  const stateRef = useRef(state);
  stateRef.current = state;
  const sensitivityRef = useRef(zoomSensitivity);
  sensitivityRef.current = zoomSensitivity;
  const animFrameRef = useRef<number | null>(null);

  useWheelZoom(viewportRef, sensitivityRef, setState);
  const { spaceHeld, cmdHeld } = useKeyboardControls(viewportRef, setState);
  const { isPanning, handlers } = useMousePan(stateRef, setState);

  useEffect(() => {
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, []);

  const zoomIn = useCallback(() => {
    setState((prev) => {
      const newZoom = clamp(prev.zoom * ZOOM_IN_FACTOR, MIN_ZOOM, MAX_ZOOM);
      const el = viewportRef.current;
      if (!el) return { ...prev, zoom: newZoom };
      const rect = el.getBoundingClientRect();
      return zoomAroundCenter(prev, newZoom, rect.width / 2, rect.height / 2);
    });
  }, []);

  const zoomOut = useCallback(() => {
    setState((prev) => {
      const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
      const el = viewportRef.current;
      if (!el) return { ...prev, zoom: newZoom };
      const rect = el.getBoundingClientRect();
      return zoomAroundCenter(prev, newZoom, rect.width / 2, rect.height / 2);
    });
  }, []);

  const resetZoom = useCallback(() => {
    setState({ panX: 0, panY: 0, zoom: 1 });
  }, []);

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const vRect = viewport.getBoundingClientRect();
    const children = content.children;
    if (children.length === 0) {
      setState({ panX: 0, panY: 0, zoom: 1 });
      return;
    }

    setState((prev) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < children.length; i++) {
        const r = children[i].getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const sx = (r.left - vRect.left - prev.panX) / prev.zoom;
        const sy = (r.top - vRect.top - prev.panY) / prev.zoom;
        minX = Math.min(minX, sx);
        minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx + r.width / prev.zoom);
        maxY = Math.max(maxY, sy + r.height / prev.zoom);
      }

      if (!isFinite(minX)) return { panX: 0, panY: 0, zoom: 1 };

      const contentWidth = maxX - minX;
      const contentHeight = maxY - minY;
      const availW = vRect.width - FIT_PADDING * 2;
      const availH = vRect.height - FIT_PADDING * 2;
      const newZoom = clamp(
        Math.min(availW / contentWidth, availH / contentHeight), MIN_ZOOM, MAX_ZOOM,
      );
      const newPanX = (vRect.width - contentWidth * newZoom) / 2 - minX * newZoom;
      const newPanY = (vRect.height - contentHeight * newZoom) / 2 - minY * newZoom;

      return { panX: newPanX, panY: newPanY, zoom: newZoom };
    });
  }, []);

  const fitToCards = useCallback((
    cardRects: Array<{ x: number; y: number; width: number; height: number }>,
    maxZoom?: number,
    animate?: boolean,
  ) => {
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }

    const viewport = viewportRef.current;
    if (!viewport || cardRects.length === 0) {
      setState({ panX: 0, panY: 0, zoom: 1 });
      return;
    }

    const vRect = viewport.getBoundingClientRect();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const card of cardRects) {
      minX = Math.min(minX, card.x);
      minY = Math.min(minY, card.y);
      maxX = Math.max(maxX, card.x + card.width);
      maxY = Math.max(maxY, card.y + card.height);
    }

    if (!isFinite(minX)) {
      setState({ panX: 0, panY: 0, zoom: 1 });
      return;
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const availW = vRect.width - FIT_PADDING * 2;
    const availH = vRect.height - FIT_PADDING * 2;
    const ceiling = maxZoom ?? MAX_ZOOM;
    const targetZoom = clamp(
      Math.min(availW / contentWidth, availH / contentHeight), MIN_ZOOM, ceiling,
    );
    const targetPanX = (vRect.width - contentWidth * targetZoom) / 2 - minX * targetZoom;
    const targetPanY = (vRect.height - contentHeight * targetZoom) / 2 - minY * targetZoom;

    if (!animate) {
      setState({ panX: targetPanX, panY: targetPanY, zoom: targetZoom });
      return;
    }

    const start = { ...stateRef.current };
    const startTime = performance.now();
    const duration = 320;

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setState({
        panX: start.panX + (targetPanX - start.panX) * ease,
        panY: start.panY + (targetPanY - start.panY) * ease,
        zoom: start.zoom + (targetZoom - start.zoom) * ease,
      });
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        animFrameRef.current = null;
      }
    };
    animFrameRef.current = requestAnimationFrame(step);
  }, []);

  const actions = useMemo(() => ({
    zoomIn, zoomOut, resetZoom, fitToView, fitToCards,
  }), [zoomIn, zoomOut, resetZoom, fitToView, fitToCards]);

  return {
    ...state,
    isPanning,
    spaceHeld,
    cmdHeld,
    viewportRef,
    contentRef,
    handlers,
    actions,
  } as const;
}
