import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

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

/**
 * Apply the current transform ref values directly to DOM elements.
 * This avoids React re-renders during panning/zooming.
 */
function applyTransform(
  contentEl: HTMLDivElement | null,
  viewportEl: HTMLDivElement | null,
  panX: number,
  panY: number,
  zoom: number,
) {
  if (contentEl) {
    contentEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  if (viewportEl) {
    const dotSize = Math.max(1, 1.5 * zoom);
    const dotSpacing = 24 * zoom;
    viewportEl.style.backgroundSize = `${dotSpacing}px ${dotSpacing}px`;
    viewportEl.style.backgroundPosition = `${panX % dotSpacing}px ${panY % dotSpacing}px`;
    viewportEl.style.backgroundImage = `radial-gradient(circle, var(--dot-color, rgba(255,255,255,0.08)) ${dotSize}px, transparent ${dotSize}px)`;
  }
}

export function useCanvasControls(zoomSensitivity: number = 50) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // React state — only updated on idle (mouseUp, wheel settle, discrete actions).
  // Used by components that truly need re-render (CanvasControls zoom display, etc.)
  const [state, setState] = useState<CanvasState>({ panX: 0, panY: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cmdHeld, setCmdHeld] = useState(false);

  // Ref-based transform — updated every frame during pan/zoom, no re-renders.
  const transformRef = useRef<CanvasState>({ panX: 0, panY: 0, zoom: 1 });
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const spaceRef = useRef(false);
  const cmdRef = useRef(false);
  const sensitivityRef = useRef(zoomSensitivity);
  sensitivityRef.current = zoomSensitivity;
  const animFrameRef = useRef<number | null>(null);
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Sync ref values to React state (triggers re-render for dependent UI) */
  const commitTransform = useCallback(() => {
    const t = transformRef.current;
    setState({ panX: t.panX, panY: t.panY, zoom: t.zoom });
  }, []);

  /** Update ref + DOM, no React re-render */
  const setTransformDirect = useCallback((panX: number, panY: number, zoom: number) => {
    transformRef.current = { panX, panY, zoom };
    applyTransform(contentRef.current, viewportRef.current, panX, panY, zoom);
  }, []);

  /** Update ref + DOM + React state (for discrete actions like keyboard zoom) */
  const setTransformFull = useCallback((next: CanvasState) => {
    transformRef.current = next;
    applyTransform(contentRef.current, viewportRef.current, next.panX, next.panY, next.zoom);
    setState(next);
  }, []);

  // Wheel zoom centered on cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
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
        if ((canScrollY || canScrollX) && !isPinchZoom) return;
        target = target.parentElement;
      }

      e.preventDefault();

      const prev = transformRef.current;

      if (isPinchZoom) {
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        const factor = Math.pow(2, -delta * sensitivityToMultiplier(sensitivityRef.current));
        const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const ratio = newZoom / prev.zoom;
        setTransformDirect(
          cx - (cx - prev.panX) * ratio,
          cy - (cy - prev.panY) * ratio,
          newZoom,
        );
      } else {
        const dx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
        const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
        setTransformDirect(prev.panX - dx, prev.panY - dy, prev.zoom);
      }

      // Debounced commit after wheel stops
      if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = setTimeout(commitTransform, 100);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setTransformDirect, commitTransform]);

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
          setTransformFull({ panX: 0, panY: 0, zoom: 1 });
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          const prev = transformRef.current;
          const newZoom = clamp(prev.zoom * ZOOM_IN_FACTOR, MIN_ZOOM, MAX_ZOOM);
          const vp = viewportRef.current;
          if (!vp) { setTransformFull({ ...prev, zoom: newZoom }); return; }
          const rect = vp.getBoundingClientRect();
          const cx = rect.width / 2;
          const cy = rect.height / 2;
          const ratio = newZoom / prev.zoom;
          setTransformFull({ panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom });
        } else if (e.key === '-') {
          e.preventDefault();
          const prev = transformRef.current;
          const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
          const vp = viewportRef.current;
          if (!vp) { setTransformFull({ ...prev, zoom: newZoom }); return; }
          const rect = vp.getBoundingClientRect();
          const cx = rect.width / 2;
          const cy = rect.height / 2;
          const ratio = newZoom / prev.zoom;
          setTransformFull({ panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom });
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceRef.current = false; setSpaceHeld(false); }
      if (e.key === 'Meta' || e.key === 'Control') { cmdRef.current = false; setCmdHeld(false); }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [setTransformFull]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsPanning(true);
    const t = transformRef.current;
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: t.panX, panY: t.panY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    setTransformDirect(start.panX + dx, start.panY + dy, transformRef.current.zoom);
  }, [setTransformDirect]);

  const handleMouseUp = useCallback(() => {
    panStartRef.current = null;
    setIsPanning(false);
    commitTransform();
  }, [commitTransform]);

  // Clean up panning if mouse leaves the window
  useEffect(() => {
    const onUp = () => {
      if (panStartRef.current) {
        panStartRef.current = null;
        setIsPanning(false);
        commitTransform();
      }
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [commitTransform]);

  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
    };
  }, []);

  const zoomIn = useCallback(() => {
    const prev = transformRef.current;
    const newZoom = clamp(prev.zoom * ZOOM_IN_FACTOR, MIN_ZOOM, MAX_ZOOM);
    const el = viewportRef.current;
    if (!el) { setTransformFull({ ...prev, zoom: newZoom }); return; }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const ratio = newZoom / prev.zoom;
    setTransformFull({ panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom });
  }, [setTransformFull]);

  const zoomOut = useCallback(() => {
    const prev = transformRef.current;
    const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
    const el = viewportRef.current;
    if (!el) { setTransformFull({ ...prev, zoom: newZoom }); return; }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const ratio = newZoom / prev.zoom;
    setTransformFull({ panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom });
  }, [setTransformFull]);

  const resetZoom = useCallback(() => {
    setTransformFull({ panX: 0, panY: 0, zoom: 1 });
  }, [setTransformFull]);

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const vRect = viewport.getBoundingClientRect();
    const children = content.children;
    if (children.length === 0) {
      setTransformFull({ panX: 0, panY: 0, zoom: 1 });
      return;
    }

    const prev = transformRef.current;
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

    if (!isFinite(minX)) { setTransformFull({ panX: 0, panY: 0, zoom: 1 }); return; }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const availW = vRect.width - FIT_PADDING * 2;
    const availH = vRect.height - FIT_PADDING * 2;
    const newZoom = clamp(Math.min(availW / contentWidth, availH / contentHeight), MIN_ZOOM, MAX_ZOOM);
    const newPanX = (vRect.width - contentWidth * newZoom) / 2 - minX * newZoom;
    const newPanY = (vRect.height - contentHeight * newZoom) / 2 - minY * newZoom;

    setTransformFull({ panX: newPanX, panY: newPanY, zoom: newZoom });
  }, [setTransformFull]);

  const fitToCards = useCallback((cardRects: Array<{ x: number; y: number; width: number; height: number }>, maxZoom?: number, animate?: boolean) => {
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }

    const viewport = viewportRef.current;
    if (!viewport || cardRects.length === 0) {
      setTransformFull({ panX: 0, panY: 0, zoom: 1 });
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
      setTransformFull({ panX: 0, panY: 0, zoom: 1 });
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
      setTransformFull({ panX: targetPanX, panY: targetPanY, zoom: targetZoom });
      return;
    }

    const start = { ...transformRef.current };
    const startTime = performance.now();
    const duration = 320;

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const panX = start.panX + (targetPanX - start.panX) * ease;
      const panY = start.panY + (targetPanY - start.panY) * ease;
      const zoom = start.zoom + (targetZoom - start.zoom) * ease;
      setTransformDirect(panX, panY, zoom);
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        animFrameRef.current = null;
        commitTransform();
      }
    };
    animFrameRef.current = requestAnimationFrame(step);
  }, [setTransformFull, setTransformDirect, commitTransform]);

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
    transformRef,
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
