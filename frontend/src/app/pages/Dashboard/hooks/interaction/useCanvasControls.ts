import { useState, useCallback, useRef, useEffect, useMemo, RefObject } from 'react';
import { setCanvasInteractionActive } from '@/shared/canvasInteractionState';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3.0;
const ZOOM_IN_FACTOR = 1.1;
const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
const FIT_PADDING = 200;

// Maps the 1 to 100 user setting to an internal multiplier (50 default = 0.004).
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

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function useCanvasControls(zoomSensitivity: number = 50, contentBounds?: ContentBounds, enabled: boolean = true) {
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
  const contentBoundsRef = useRef(contentBounds);
  contentBoundsRef.current = contentBounds;
  const animFrameRef = useRef<number | null>(null);
  const inertiaFrameRef = useRef<number | null>(null);
  // Cancelled on any pan/zoom/animation so a stale settle never overrides fresh input or back-to-back fitToCards.
  const settleTimerRef = useRef<number | null>(null);

  const velocityHistoryRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const FRICTION = 0.93;
  const MIN_VELOCITY = 0.5;

  const cancelInertia = useCallback(() => {
    if (inertiaFrameRef.current) {
      cancelAnimationFrame(inertiaFrameRef.current);
      inertiaFrameRef.current = null;
    }
  }, []);

  const startInertia = useCallback((vx: number, vy: number) => {
    cancelInertia();
    let velocityX = vx;
    let velocityY = vy;

    const step = () => {
      velocityX *= FRICTION;
      velocityY *= FRICTION;

      if (Math.abs(velocityX) < MIN_VELOCITY && Math.abs(velocityY) < MIN_VELOCITY) {
        inertiaFrameRef.current = null;
        springBackIfNeeded();
        return;
      }

      setState((prev) => ({
        ...prev,
        panX: prev.panX + velocityX,
        panY: prev.panY + velocityY,
      }));

      inertiaFrameRef.current = requestAnimationFrame(step);
    };
    inertiaFrameRef.current = requestAnimationFrame(step);
  }, [cancelInertia]);

  // ---- Soft pan boundaries: spring back if viewport drifts too far from content ----
  const BOUNDARY_MARGIN = 800; // extra px beyond content bounds before spring-back
  const springBackIfNeeded = useCallback(() => {
    const bounds = contentBoundsRef.current;
    const vp = viewportRef.current;
    if (!bounds || !vp) return;

    const cur = stateRef.current;
    const vpW = vp.clientWidth;
    const vpH = vp.clientHeight;

    // Viewport in canvas coords
    const vpLeft = -cur.panX / cur.zoom;
    const vpTop = -cur.panY / cur.zoom;
    const vpRight = vpLeft + vpW / cur.zoom;
    const vpBottom = vpTop + vpH / cur.zoom;

    const bLeft = bounds.minX - BOUNDARY_MARGIN;
    const bTop = bounds.minY - BOUNDARY_MARGIN;
    const bRight = bounds.maxX + BOUNDARY_MARGIN;
    const bBottom = bounds.maxY + BOUNDARY_MARGIN;

    let newPanX = cur.panX;
    let newPanY = cur.panY;

    // If viewport is completely outside bounds, nudge it back
    if (vpRight < bLeft) {
      newPanX = -(bLeft - vpW / cur.zoom) * cur.zoom;
    } else if (vpLeft > bRight) {
      newPanX = -bRight * cur.zoom;
    }
    if (vpBottom < bTop) {
      newPanY = -(bTop - vpH / cur.zoom) * cur.zoom;
    } else if (vpTop > bBottom) {
      newPanY = -bBottom * cur.zoom;
    }

    if (newPanX !== cur.panX || newPanY !== cur.panY) {
      // animateTo will be available by the time this runs
      animateToRef.current?.({ panX: newPanX, panY: newPanY, zoom: cur.zoom }, 250);
    }
  }, []);

  const cancelAnimation = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    // Kill pending settle so a stale snap doesn't fire after the user pans or fitToCards is recalled.
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const animateToRef = useRef<((target: CanvasState, duration?: number) => void) | null>(null);

  const animateTo = useCallback((target: CanvasState, duration: number = 320) => {
    cancelAnimation();
    const start = { ...stateRef.current };
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
      setState({
        panX: start.panX + (target.panX - start.panX) * ease,
        panY: start.panY + (target.panY - start.panY) * ease,
        zoom: start.zoom + (target.zoom - start.zoom) * ease,
      });
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        animFrameRef.current = null;
      }
    };
    animFrameRef.current = requestAnimationFrame(step);
  }, [cancelAnimation]);

  animateToRef.current = animateTo;

  // Wheel zoom centered on cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !enabled) return;  // Skip wheel listener when canvas is hidden

    // RAF-coalesce wheel state updates; trackpads at 120Hz would otherwise re-render Dashboard per event.
    let pendingPanDx = 0;
    let pendingPanDy = 0;
    let pendingZoomDy = 0;
    let pendingZoomCenter: { cx: number; cy: number } | null = null;
    let wheelRafId: number | null = null;
    // No "gestureend" on trackpads; 140ms idle declares the gesture over (short enough to feel snappy, long enough to span inter-burst gaps).
    let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const flushWheel = () => {
      wheelRafId = null;
      const dx = pendingPanDx; const dy = pendingPanDy;
      const zDy = pendingZoomDy; const zCenter = pendingZoomCenter;
      pendingPanDx = 0; pendingPanDy = 0;
      pendingZoomDy = 0; pendingZoomCenter = null;

      if (zCenter && zDy !== 0) {
        setState((prev) => {
          const factor = Math.pow(2, -zDy * sensitivityToMultiplier(sensitivityRef.current));
          const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          const ratio = newZoom / prev.zoom;
          return {
            panX: zCenter.cx - (zCenter.cx - prev.panX) * ratio,
            panY: zCenter.cy - (zCenter.cy - prev.panY) * ratio,
            zoom: newZoom,
          };
        });
      } else if (dx !== 0 || dy !== 0) {
        setState((prev) => ({
          ...prev,
          panX: prev.panX - dx,
          panY: prev.panY - dy,
        }));
      }
    };

    const scheduleWheelFlush = () => {
      // Mark the canvas as actively-interacting and (re)arm the idle
      // timer. Any ResizeObserver / streaming reconciler that checks the
      // flag will bail until the user's gesture goes quiet for ~140ms.
      setCanvasInteractionActive(true);
      if (wheelIdleTimer != null) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        wheelIdleTimer = null;
        setCanvasInteractionActive(false);
      }, 140);
      if (wheelRafId != null) return;
      wheelRafId = requestAnimationFrame(flushWheel);
    };

    // Cache "is this element a scrollable child" decision per node. The
    // Cache getComputedStyle ancestor walks; uncached was the dominant cost of trackpad two-finger nav. ResizeObserver below invalidates on scroll-capacity change.
    const scrollableCache: WeakMap<HTMLElement, 'scrollable' | 'not'> = new WeakMap();

    const onWheel = (e: WheelEvent) => {
      // Pinch-to-zoom on trackpads sets ctrlKey; plain scroll does not
      const isPinchZoom = e.ctrlKey || e.metaKey;

      // Let scrollable children handle the event when appropriate,
      // but fall through to canvas pan if the child is at its scroll boundary.
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
      let target = e.target as HTMLElement | null;
      while (target && target !== el) {
        let cls = scrollableCache.get(target);
        if (cls === undefined) {
          const couldScroll =
            target.scrollHeight > target.clientHeight ||
            target.scrollWidth > target.clientWidth;
          if (couldScroll) {
            const style = getComputedStyle(target);
            const oy = style.overflowY;
            const ox = style.overflowX;
            const isOverflowScrollable =
              oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll';
            cls = isOverflowScrollable ? 'scrollable' : 'not';
          } else {
            cls = 'not';
          }
          scrollableCache.set(target, cls);
        }

        if (cls === 'scrollable' && !isPinchZoom) {
          // Re-read scrollHeight/clientHeight; cached decision is structural, scroll position is dynamic.
          const canScrollY = target.scrollHeight > target.clientHeight;
          const canScrollX = target.scrollWidth > target.clientWidth;
          const atYBoundary = !canScrollY ||
            (dy > 0 && target.scrollTop + target.clientHeight >= target.scrollHeight - 1) ||
            (dy < 0 && target.scrollTop <= 1);
          const atXBoundary = !canScrollX ||
            (dx > 0 && target.scrollLeft + target.clientWidth >= target.scrollWidth - 1) ||
            (dx < 0 && target.scrollLeft <= 1);

          if (atYBoundary && atXBoundary) {
            target = target.parentElement;
            continue;
          }
          return;
        }
        target = target.parentElement;
      }

      e.preventDefault();
      if (inertiaFrameRef.current) {
        cancelAnimationFrame(inertiaFrameRef.current);
        inertiaFrameRef.current = null;
      }

      if (isPinchZoom) {
        // Pinch gesture → accumulate zoom deltas + last cursor position.
        // factor = 2^(-Σdy·s) which equals the product of per-event
        // factors, so accumulating dy is mathematically identical to
        // applying each event one at a time.
        const rect = el.getBoundingClientRect();
        pendingZoomDy += dy;
        pendingZoomCenter = { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
        scheduleWheelFlush();
      } else {
        // Two-finger scroll → accumulate pan deltas.
        pendingPanDx += dx;
        pendingPanDy += dy;
        scheduleWheelFlush();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });

    // ctrl/meta+wheel events that originate inside an Electron <webview>
    // never bubble out of the guest into the host DOM, so the wheel
    // listener above can't see them. BrowserCard's preload-bridge
    // forwards those gestures via this CustomEvent (issue #27); we run
    // the same zoom-around-cursor math the wheel handler uses.
    const onForwardedZoom = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const dy = detail.deltaMode === 1 ? detail.deltaY * 40 : detail.deltaY;
      const rect = el.getBoundingClientRect();
      if (inertiaFrameRef.current) {
        cancelAnimationFrame(inertiaFrameRef.current);
        inertiaFrameRef.current = null;
      }
      pendingZoomDy += dy;
      pendingZoomCenter = {
        cx: (detail.clientX ?? 0) - rect.left,
        cy: (detail.clientY ?? 0) - rect.top,
      };
      scheduleWheelFlush();
    };
    window.addEventListener('openswarm:canvas-wheel-zoom', onForwardedZoom);

    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('openswarm:canvas-wheel-zoom', onForwardedZoom);
      if (wheelRafId != null) cancelAnimationFrame(wheelRafId);
      if (wheelIdleTimer != null) clearTimeout(wheelIdleTimer);
      // Don't leave the flag stuck on if the canvas unmounts mid-gesture.
      setCanvasInteractionActive(false);
    };
  }, [enabled]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    cancelAnimation();
    cancelInertia();
    setIsPanning(true);
    setCanvasInteractionActive(true);
    velocityHistoryRef.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: stateRef.current.panX,
      panY: stateRef.current.panY,
    };
  }, [cancelAnimation, cancelInertia]);

  // RAF-coalesce drag pan; setState per event caused "hop hop hop" feel. Velocity history still captures per-event for inertia accuracy.
  const dragRafRef = useRef<number | null>(null);
  const latestDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const flushDrag = useCallback(() => {
    dragRafRef.current = null;
    const start = panStartRef.current;
    const latest = latestDragRef.current;
    if (!start || !latest) return;
    setState((prev) => ({
      ...prev,
      panX: start.panX + latest.dx,
      panY: start.panY + latest.dy,
    }));
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    // Velocity history is per-event so inertia stays accurate on
    // mouseup. Cheap; just pushes to a length-5 ring buffer.
    const now = performance.now();
    const history = velocityHistoryRef.current;
    history.push({ x: e.clientX, y: e.clientY, t: now });
    if (history.length > 5) history.shift();

    latestDragRef.current = { dx, dy };
    if (dragRafRef.current == null) {
      dragRafRef.current = requestAnimationFrame(flushDrag);
    }
  }, [flushDrag]);

  const handleMouseUp = useCallback(() => {
    // Apply any pending drag delta synchronously so the final position
    // matches where the cursor was released, then drop the scheduled RAF.
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
      flushDrag();
    }
    latestDragRef.current = null;
    const wasPanning = !!panStartRef.current;
    let didInertia = false;
    if (wasPanning) {
      // Compute velocity from recent mouse history
      const history = velocityHistoryRef.current;
      if (history.length >= 2) {
        const oldest = history[0];
        const newest = history[history.length - 1];
        const dt = newest.t - oldest.t;
        if (dt > 0 && dt < 200) {
          const vx = (newest.x - oldest.x) / (dt / 16.67); // px per frame
          const vy = (newest.y - oldest.y) / (dt / 16.67);
          if (Math.abs(vx) > MIN_VELOCITY || Math.abs(vy) > MIN_VELOCITY) {
            startInertia(vx, vy);
            didInertia = true;
          }
        }
      }
      velocityHistoryRef.current = [];
    }
    panStartRef.current = null;
    setIsPanning(false);
    setCanvasInteractionActive(false);
    // Only spring back if we were actually panning (not on simple clicks)
    if (wasPanning && !didInertia) {
      springBackIfNeeded();
    }
  }, [startInertia, springBackIfNeeded]);

  // Clean up panning if mouse leaves the window
  useEffect(() => {
    const onUp = () => {
      if (panStartRef.current) {
        panStartRef.current = null;
        setIsPanning(false);
        setCanvasInteractionActive(false);
      }
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    return () => { cancelAnimation(); cancelInertia(); };
  }, [cancelAnimation, cancelInertia]);

  const zoomIn = useCallback(() => {
    const prev = stateRef.current;
    const newZoom = clamp(prev.zoom * ZOOM_IN_FACTOR, MIN_ZOOM, MAX_ZOOM);
    const el = viewportRef.current;
    if (!el) { animateTo({ ...prev, zoom: newZoom }, 150); return; }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const ratio = newZoom / prev.zoom;
    animateTo({ panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom }, 150);
  }, [animateTo]);

  const zoomOut = useCallback(() => {
    const prev = stateRef.current;
    const newZoom = clamp(prev.zoom * ZOOM_OUT_FACTOR, MIN_ZOOM, MAX_ZOOM);
    const el = viewportRef.current;
    if (!el) { animateTo({ ...prev, zoom: newZoom }, 150); return; }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const ratio = newZoom / prev.zoom;
    animateTo({ panX: cx - (cx - prev.panX) * ratio, panY: cy - (cy - prev.panY) * ratio, zoom: newZoom }, 150);
  }, [animateTo]);

  const resetZoom = useCallback(() => {
    animateTo({ panX: 0, panY: 0, zoom: 1 });
  }, [animateTo]);

  // Stable refs for keyboard handler (avoids re-registering keydown listener)
  const zoomInRef = useRef(zoomIn);
  zoomInRef.current = zoomIn;
  const zoomOutRef = useRef(zoomOut);
  zoomOutRef.current = zoomOut;
  const resetZoomRef = useRef(resetZoom);
  resetZoomRef.current = resetZoom;

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
          resetZoomRef.current();
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          zoomInRef.current();
        } else if (e.key === '-') {
          e.preventDefault();
          zoomOutRef.current();
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

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const vRect = viewport.getBoundingClientRect();
    const children = content.children;
    if (children.length === 0) {
      animateTo({ panX: 0, panY: 0, zoom: 1 });
      return;
    }

    const prev = stateRef.current;
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

    if (!isFinite(minX)) { animateTo({ panX: 0, panY: 0, zoom: 1 }); return; }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const availW = vRect.width - FIT_PADDING * 2;
    const availH = vRect.height - FIT_PADDING * 2;
    const newZoom = clamp(Math.min(availW / contentWidth, availH / contentHeight), MIN_ZOOM, MAX_ZOOM);
    const newPanX = (vRect.width - contentWidth * newZoom) / 2 - minX * newZoom;
    const newPanY = (vRect.height - contentHeight * newZoom) / 2 - minY * newZoom;

    animateTo({ panX: newPanX, panY: newPanY, zoom: newZoom });
  }, [animateTo]);

  // Extracted so we can re-run after animation to detect viewport-rect drift (sidebar collapse, route switch).
  const computeFitTarget = useCallback(
    (
      cardRects: Array<{ x: number; y: number; width: number; height: number }>,
      maxZoom?: number,
      minZoom?: number,
    ): { panX: number; panY: number; zoom: number } | null => {
      const viewport = viewportRef.current;
      if (!viewport || cardRects.length === 0) return null;
      const vRect = viewport.getBoundingClientRect();
      if (vRect.width <= 0 || vRect.height <= 0) return null;

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const card of cardRects) {
        minX = Math.min(minX, card.x);
        minY = Math.min(minY, card.y);
        maxX = Math.max(maxX, card.x + card.width);
        maxY = Math.max(maxY, card.y + card.height);
      }
      if (!isFinite(minX)) return null;

      const contentWidth = maxX - minX;
      const contentHeight = maxY - minY;
      const availW = vRect.width - FIT_PADDING * 2;
      const availH = vRect.height - FIT_PADDING * 2;
      const ceiling = maxZoom ?? MAX_ZOOM;
      const floor = minZoom ?? MIN_ZOOM;
      const targetZoom = clamp(
        Math.min(availW / contentWidth, availH / contentHeight),
        floor,
        ceiling,
      );
      const targetPanX =
        (vRect.width - contentWidth * targetZoom) / 2 - minX * targetZoom;
      const topBiased = cardRects.length === 1;
      const targetPanY = topBiased
        ? FIT_PADDING * 0.4 - minY * targetZoom
        : (vRect.height - contentHeight * targetZoom) / 2 -
          minY * targetZoom;
      return { panX: targetPanX, panY: targetPanY, zoom: targetZoom };
    },
    [],
  );

  const fitToCards = useCallback(
    (
      cardRects: Array<{ x: number; y: number; width: number; height: number }>,
      maxZoom?: number,
      animate?: boolean,
      minZoom?: number,
    ) => {
      cancelAnimation();

      const target = computeFitTarget(cardRects, maxZoom, minZoom);
      if (!target) {
        // Keep current camera; snapping to (0,0,1) used to desync the minimap.
        if (cardRects.length === 0 || !viewportRef.current) {
          setState({ panX: 0, panY: 0, zoom: 1 });
        }
        return;
      }

      if (animate) {
        const cur = stateRef.current;
        const dPan = Math.abs(cur.panX - target.panX) + Math.abs(cur.panY - target.panY);
        const dZoom = Math.abs(cur.zoom - target.zoom);
        if (dPan < 5 && dZoom < 0.01) return;
        animateTo(target);
        // Settle pass: cancelAnimation() must be able to cancel it, else back-to-back fitToCards races and the first settle overwrites the second target.
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          const fresh = computeFitTarget(cardRects, maxZoom, minZoom);
          if (!fresh) return;
          const cur2 = stateRef.current;
          const drift =
            Math.abs(cur2.panX - fresh.panX) +
            Math.abs(cur2.panY - fresh.panY) +
            Math.abs(cur2.zoom - fresh.zoom) * 1000;
          if (drift > 8) setState(fresh);
        }, 370);
      } else {
        setState(target);
      }
    },
    [cancelAnimation, animateTo, computeFitTarget],
  );

  const handlers = useMemo(() => ({
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
  }), [handleMouseDown, handleMouseMove, handleMouseUp]);

  const actions = useMemo(() => ({
    zoomIn, zoomOut, resetZoom, fitToView, fitToCards, animateTo, cancelAnimation, setState,
  }), [zoomIn, zoomOut, resetZoom, fitToView, fitToCards, animateTo, cancelAnimation]);

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
