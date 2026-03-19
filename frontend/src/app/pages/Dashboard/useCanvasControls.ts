import { useState, useCallback, useRef, useEffect, useMemo, RefObject } from 'react';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3.0;
const ZOOM_IN_FACTOR = 1.1;
const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
const FIT_PADDING = 200;

// Maps the 1–100 user setting to an internal multiplier.
// 50 (default) → 0.004, 1 → 0.0004, 100 → 0.008
function sensitivityToMultiplier(setting: number): number {
  return 0.00008 * setting;
}

interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

export function useCanvasControls(zoomSensitivity: number = 50) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState<CanvasState>({ panX: 0, panY: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cmdHeld, setCmdHeld] = useState(false);

  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const spaceRef = useRef(false);
  const cmdRef = useRef(false);
  const sensitivityRef = useRef(zoomSensitivity);
  sensitivityRef.current = zoomSensitivity;
  const animFrameRef = useRef<number | null>(null);

  // Wheel zoom centered on cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Pinch-to-zoom on trackpads sets ctrlKey; plain scroll does not
      const isPinchZoom = e.ctrlKey || e.metaKey;

      // Let scrollable children handle the event when appropriate
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

        if ((canScrollY || canScrollX) && !isPinchZoom) {
          return;
        }
        target = target.parentElement;
      }

      e.preventDefault();

      if (isPinchZoom) {
        // Pinch gesture → zoom centered on cursor
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        setState((prev) => {
          const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
          const factor = Math.pow(2, -delta * sensitivityToMultiplier(sensitivityRef.current));
          const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          const ratio = newZoom / prev.zoom;
          return {
            panX: cx - (cx - prev.panX) * ratio,
            panY: cy - (cy - prev.panY) * ratio,
            zoom: newZoom,
          };
        });
      } else {
        // Two-finger scroll → pan
        const dx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
        const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;

        setState((prev) => ({
          ...prev,
          panX: prev.panX - dx,
          panY: prev.panY - dy,
        }));
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Space key tracking
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.code === 'Space' && !e.repeat && !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)) {
        e.preventDefault();
        spaceRef.current = true;
        setSpaceHeld(true);
      }
      if ((e.key === 'Meta' || e.key === 'Control') && !e.repeat) {
        cmdRef.current = true;
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
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            const ratio = newZoom / prev.zoom;
            return { panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom };
          });
        } else if (e.key === '-') {
          e.preventDefault();
          setState((prev) => {
            const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
            const el = viewportRef.current;
            if (!el) return { ...prev, zoom: newZoom };
            const rect = el.getBoundingClientRect();
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            const ratio = newZoom / prev.zoom;
            return { panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom };
          });
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
      if (e.key === 'Meta' || e.key === 'Control') {
        cmdRef.current = false;
        setCmdHeld(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: stateRef.current.panX,
      panY: stateRef.current.panY,
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    setState((prev) => ({
      ...prev,
      panX: start.panX + dx,
      panY: start.panY + dy,
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    panStartRef.current = null;
    setIsPanning(false);
  }, []);

  // Clean up panning if mouse leaves the window
  useEffect(() => {
    const onUp = () => {
      if (panStartRef.current) {
        panStartRef.current = null;
        setIsPanning(false);
      }
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, []);

  const zoomIn = useCallback(() => {
    setState((prev) => {
      const newZoom = clamp(prev.zoom * ZOOM_IN_FACTOR, MIN_ZOOM, MAX_ZOOM);
      const el = viewportRef.current;
      if (!el) return { ...prev, zoom: newZoom };
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ratio = newZoom / prev.zoom;
      return { panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom };
    });
  }, []);

  const zoomOut = useCallback(() => {
    setState((prev) => {
      const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
      const el = viewportRef.current;
      if (!el) return { ...prev, zoom: newZoom };
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ratio = newZoom / prev.zoom;
      return { panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom };
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
      const newZoom = clamp(Math.min(availW / contentWidth, availH / contentHeight), MIN_ZOOM, MAX_ZOOM);
      const newPanX = (vRect.width - contentWidth * newZoom) / 2 - minX * newZoom;
      const newPanY = (vRect.height - contentHeight * newZoom) / 2 - minY * newZoom;

      return { panX: newPanX, panY: newPanY, zoom: newZoom };
    });
  }, []);

  const fitToCards = useCallback((cardRects: Array<{ x: number; y: number; width: number; height: number }>, maxZoom?: number, animate?: boolean) => {
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
    const targetZoom = clamp(Math.min(availW / contentWidth, availH / contentHeight), MIN_ZOOM, ceiling);
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

  const handlers = useMemo(() => ({
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
  }), [handleMouseDown, handleMouseMove, handleMouseUp]);

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

export type CanvasActions = ReturnType<typeof useCanvasControls>['actions'];
