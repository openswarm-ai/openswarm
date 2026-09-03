import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { store } from '@/shared/state/store';
import { selectFullscreenCardId } from '@/shared/state/dashboardLayoutSlice';
import { setCanvasInteractionActive } from '@/shared/canvasInteractionState';
import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { getScrollFocusedCard } from '@/shared/cardScrollFocus';
import { APP_WINDOW_SELECTOR, CANVAS_OWNER, heldBy, WheelGesture } from './wheelGestureOwner';
import { markInteraction } from '@/shared/interactionPriority';
import { getWebview } from '@/shared/browserRegistry';
import { applyBrowserZoom } from '@/shared/browserZoom';
import { syncTiledGeometry } from '../../canvas/tiledGeometry';
import { revealZoom, REVEAL_MIN_ZOOM } from '../../canvas/revealZoom';
import { classifyWheelDevice } from './classifyWheelDevice';

// Surfaces that are WINDOWS, not canvas cards: they behave like an OS window, so a wheel inside one
// belongs to it whether or not you clicked in first. Canvas cards (agent, browser, view) keep the
// Google Maps model instead, where a plain scroll over an unfocused card drives the canvas.

const MIN_ZOOM = 0.15;
// The floor for AUTOMATIC reveals only. revealCards takes min(current, fit), which can only ever go
// down, so every spawn that did not fit ratcheted the camera out and nothing ever brought it back:
// measured 100% -> 88% -> 79% -> 61% -> 36% -> 18% over one ordinary session, at which point no word
// on the canvas is readable. A hand-driven zoom can still go all the way to MIN_ZOOM.

export const MAX_ZOOM = 3.0;
const ZOOM_IN_FACTOR = 1.1;
const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
const FIT_PADDING = 200;
// Tidy frames everything at once, so it gets its own tighter margin than a single-card fit. The wider
// x inset is the left dock, which floats over the canvas and would otherwise sit on the first column.
const TIDY_PADDING = { x: 120, y: 56 };
const TIDY_MIN_ZOOM = REVEAL_MIN_ZOOM;
// Card-framing (spawn, click-to-focus, arrow-nav) snaps as fast as the zoom buttons so a new card lands under you now, not after a lazy glide.
const FIT_DURATION = 340;
// Must outlast FIT_DURATION so the drift re-snap lands after the glide, never mid-flight.
const FIT_SETTLE_DELAY = FIT_DURATION + 60;
// A mouse notch lands as deltaY 100 where a trackpad sends ~1-10, so cap the per-event zoom delta: uncapped, one notch is a ~24% jump and macOS wheel acceleration stacks them. No-op for trackpads.
const WHEEL_ZOOM_DELTA_CAP = 24;
// Trackpad-vs-mouse wheel split (the Google Maps trackpad model): a two-finger scroll PANS, only a
// discrete mouse notch (or pinch) zooms. Fresh verdicts use the shape of the event (line-mode or a
// big integer no-X delta = mouse); events inside a burst inherit the previous verdict because a
// physical device can't change mid-gesture, which keeps momentum-glide events panning.
const WHEEL_STREAM_GAP_MS = 150;

// Maps the 1 to 100 user setting to an internal multiplier. Recentered twice (Eric): 2026-07-24
// made the old max the new 50, and 2026-08-08 turned it up again so 50 feels like the old 75; the
// labels never move, the whole dial just runs 1.5x hotter.
function sensitivityToMultiplier(setting: number): number {
  return 0.00024 * setting;
}

interface CanvasState {
  panX: number;
  panY: number;
  zoom: number;
}

function clamp(val: number, min: number, max: number) {
  // NaN survives Math.min/max, and one NaN in the camera makes the whole transform NaN: the canvas
  // stops panning, cards land at NaN coordinates and vanish, and the readout says "NaN%". A fit
  // against a zero-size viewport (0/0) is enough to produce it, so refuse it here (ENG-244).
  if (!Number.isFinite(val)) return min;
  return Math.min(max, Math.max(min, val));
}

/** No non-finite value may ever enter the camera; a single NaN breaks navigation until reload. */
function sanitizeCamera(next: CanvasState, prev: CanvasState): CanvasState {
  const ok = Number.isFinite(next.panX) && Number.isFinite(next.panY) && Number.isFinite(next.zoom) && next.zoom > 0;
  if (ok) return next;
  console.warn('[canvas] refused a non-finite camera', next);
  return { panX: Number.isFinite(prev.panX) ? prev.panX : 0, panY: Number.isFinite(prev.panY) ? prev.panY : 0, zoom: Number.isFinite(prev.zoom) && prev.zoom > 0 ? prev.zoom : 1 };
}

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function useCanvasControls(
  zoomSensitivity: number = 50,
  contentBounds?: ContentBounds,
  enabled: boolean = true,
  wheelAction: 'zoom' | 'scroll' = 'zoom',
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState<CanvasState>({ panX: 0, panY: 0, zoom: 1 });
  // The grab cursor is a style write, not state: a state flip on mousedown rendered the whole board synchronously (77-100 ms under load) before the first pan frame.
  const setPanCursor = useCallback((panning: boolean) => {
    const vp = viewportRef.current;
    if (vp) vp.style.cursor = panning ? 'grabbing' : '';
  }, []);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cmdHeld, setCmdHeld] = useState(false);

  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  // stateRef is the LIVE camera truth (single writer: applyLive / setCanvasState below). React state is a lagging copy committed once per gesture-end, so a 120Hz pan doesn't re-render the card tree per frame. Never sync stateRef FROM state: a render mid-gesture would clobber live with stale.
  const stateRef = useRef(state);
  const liveDirtyRef = useRef(false);
  const spaceRef = useRef(false);
  const sensitivityRef = useRef(zoomSensitivity);
  sensitivityRef.current = zoomSensitivity;
  // Read through a ref, like sensitivity: the wheel listener is bound once per mount, so a plain
  // closure over the prop would keep the value the canvas had when it mounted and the setting
  // would appear to do nothing until you switched dashboards.
  const wheelActionRef = useRef(wheelAction);
  wheelActionRef.current = wheelAction;
  const contentBoundsRef = useRef(contentBounds);
  contentBoundsRef.current = contentBounds;
  const animFrameRef = useRef<number | null>(null);
  const inertiaFrameRef = useRef<number | null>(null);
  // Cancelled on any pan/zoom/animation so a stale settle never overrides fresh input or back-to-back fitToCards.
  const settleTimerRef = useRef<number | null>(null);

  const velocityHistoryRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const FRICTION = 0.93;
  const MIN_VELOCITY = 0.5;

  // Paints stateRef onto the DOM: content transform (compositor-only) + dot-grid phase/scale. Also the after-render re-apply, so a foreign React render mid-gesture can't paint the stale committed transform for a frame.
  const applyLiveToDom = useCallback(() => {
    const { panX, panY, zoom } = stateRef.current;
    const content = contentRef.current;
    if (content) content.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const grid = gridRef.current;
    if (grid) {
      const spacing = 24 * zoom;
      // Phase rides a compositor transform (the element is bled past the viewport); backgroundPosition here repainted the whole viewport every pan frame.
      grid.style.transform = `translate3d(${panX % spacing}px, ${panY % spacing}px, 0)`;
      // Dot RADIUS lives in the committed backgroundImage and lags to gesture-end; at 1-4px dots the mid-pinch error is invisible and skipping the per-frame gradient rebuild keeps this handler pure style writes.
      grid.style.backgroundSize = `${spacing}px ${spacing}px`;
    }
    // Tiled cards are counter-transformed against this exact camera, in this exact task: same write,
    // same frame, so the tile and the canvas can never be painted from two different cameras.
    syncTiledGeometry(stateRef.current);
  }, []);

  // Per-frame camera write during a gesture: DOM + live ref only, NO React commit. Dragging cards re-pin to the cursor off the pan-changed event, same signal the old per-frame commit produced.
  const applyLive = useCallback((raw: CanvasState) => {
    const next = sanitizeCamera(raw, stateRef.current);
    stateRef.current = next;
    liveDirtyRef.current = true;
    applyLiveToDom();
    window.dispatchEvent(new Event('openswarm:canvas-pan-changed'));
  }, [applyLiveToDom]);

  // Gesture-end: reconcile React (minimap, zoom label, webview suspend) with the live camera in ONE render.
  const commitLive = useCallback(() => {
    if (!liveDirtyRef.current) return;
    liveDirtyRef.current = false;
    setState(stateRef.current);
  }, []);

  // Discrete camera set (minimap jump, fit fallbacks): live + committed in the same call. The ONLY sanctioned writers are this and applyLive; a new pan path calling raw setState reintroduces the camera-snaps-back class.
  const setCanvasState = useCallback((updater: CanvasState | ((prev: CanvasState) => CanvasState)) => {
    const raw = typeof updater === 'function' ? updater(stateRef.current) : updater;
    const next = sanitizeCamera(raw, stateRef.current);
    stateRef.current = next;
    liveDirtyRef.current = false;
    applyLiveToDom();
    setState(next);
  }, [applyLiveToDom]);

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
        commitLive();
        springBackIfNeeded();
        return;
      }

      const prev = stateRef.current;
      applyLive({ ...prev, panX: prev.panX + velocityX, panY: prev.panY + velocityY });

      inertiaFrameRef.current = requestAnimationFrame(step);
    };
    inertiaFrameRef.current = requestAnimationFrame(step);
  }, [cancelInertia, applyLive, commitLive]);

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
    // The guard used to run one way only: starting a pan cancels a running fly, but a fly starting
    // DURING a drag was free to run, and then two writers drive the camera from different origins on
    // the same frames. That reads as the viewport jumping a long way mid-drag (ENG-299). The user's
    // hand wins: a fly requested while they are dragging is dropped, not queued, because landing it
    // afterwards would move the world out from under a hand that had already stopped.
    if (panStartRef.current) return;
    cancelAnimation();
    const start = { ...stateRef.current };
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      // Quintic ease-out: leaves fast, lands soft. The old cubic at 150ms read as a snap; the eye
      // reads the long tail as "the camera settled" rather than "the world jumped".
      const ease = 1 - Math.pow(1 - t, 5);
      applyLive({
        panX: start.panX + (target.panX - start.panX) * ease,
        panY: start.panY + (target.panY - start.panY) * ease,
        zoom: start.zoom + (target.zoom - start.zoom) * ease,
      });
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        animFrameRef.current = null;
        commitLive();
      }
    };
    animFrameRef.current = requestAnimationFrame(step);
  }, [cancelAnimation, applyLive, commitLive]);

  animateToRef.current = animateTo;

  // Google Maps wheel model: mouse notch zooms at the cursor, two-finger trackpad scroll pans, pinch zooms at the cursor, held cmd/ctrl+wheel pans vertically (the mouse user's pan).
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
    // Device classification for the trackpad-pan vs mouse-zoom split; per-mount so a stale verdict can't leak across dashboards.
    let lastWheelDeviceAt = 0;
    let lastWheelWasTrackpad = false;

    const classifyTrackpad = (e: WheelEvent, dx: number, dy: number): boolean => {
      const inStream = e.timeStamp - lastWheelDeviceAt < WHEEL_STREAM_GAP_MS;
      lastWheelDeviceAt = e.timeStamp;
      if (inStream) return lastWheelWasTrackpad;
      lastWheelWasTrackpad = classifyWheelDevice(e as WheelEvent & { wheelDeltaY?: number }, dx, dy);
      return lastWheelWasTrackpad;
    };

    const flushWheel = () => {
      wheelRafId = null;
      const dx = pendingPanDx; const dy = pendingPanDy;
      const zDy = pendingZoomDy; const zCenter = pendingZoomCenter;
      pendingPanDx = 0; pendingPanDy = 0;
      pendingZoomDy = 0; pendingZoomCenter = null;

      const prev = stateRef.current;
      if (zCenter && zDy !== 0) {
        const factor = Math.pow(2, -zDy * sensitivityToMultiplier(sensitivityRef.current));
        const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const ratio = newZoom / prev.zoom;
        // Apply any pan accumulated in the same frame too: a zoom and a pan can now land together (vertical zoom + horizontal pan across a RAF boundary, or a forwarded pan), and dropping it would swallow the gesture.
        applyLive({
          panX: zCenter.cx - (zCenter.cx - prev.panX) * ratio - dx,
          panY: zCenter.cy - (zCenter.cy - prev.panY) * ratio - dy,
          zoom: newZoom,
        });
      } else if (dx !== 0 || dy !== 0) {
        applyLive({ ...prev, panX: prev.panX - dx, panY: prev.panY - dy });
      }
    };

    const scheduleWheelFlush = () => {
      // Mark the canvas as actively-interacting and (re)arm the idle timer. Any ResizeObserver / streaming reconciler that checks the flag will bail until the user's gesture goes quiet for ~140ms.
      setCanvasInteractionActive(true);
      if (wheelIdleTimer != null) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        wheelIdleTimer = null;
        setCanvasInteractionActive(false);
        commitLive();
      }, 140);
      if (wheelRafId != null) return;
      wheelRafId = requestAnimationFrame(flushWheel);
    };

    // Cache "is this element a scrollable child" decision per node. The Cache getComputedStyle ancestor walks; uncached was the dominant cost of trackpad two-finger nav. ResizeObserver below invalidates on scroll-capacity change.
    const scrollableCache: WeakMap<HTMLElement, 'scrollable' | 'not'> = new WeakMap();
    const gesture: WheelGesture = { owner: null, at: 0 };

    const onWheel = (e: WheelEvent) => {
      // Full size view owns the whole surface: any wheel that escapes the chat's scroll container
      // (side gutters, header) must NOT zoom/pan the hidden canvas underneath, that read as a
      // glitchy zoom while scrolling the chat. Fullscreen has no canvas nav, period. The selector's
      // existence check matters: a stale tile entry for a removed card would wedge the wheel forever.
      // Swallow it rather than just ignoring it: the host window now allows visual zoom (so macOS
      // delivers pinch at all), which means an un-prevented pinch here would magnify the whole UI
      // instead of doing nothing.
      if (selectFullscreenCardId(store.getState())) {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
      // The owner of the gesture in flight keeps it. Zoom is exempt on every surface, so a pinch is
      // always reachable. This runs ABOVE the ownership rules below on purpose: a rule that decides
      // an owner must never get to overrule one that is already decided.
      const held = heldBy(gesture, Date.now(), e.ctrlKey || e.metaKey, e.target);
      // Same gesture, still over the surface that owns it: let it scroll (or hit its end) natively.
      if (held !== null && held !== CANVAS_OWNER) {
        gesture.at = Date.now();
        return;
      }
      const canvasOwnsGesture = held === CANVAS_OWNER;
      // App windows (Settings, Marketplace, the Workflows hub) own every wheel inside them, without
      // needing a click first: their inner panels are scroll containers whose exact hit target often
      // is not itself scrollable, and the walk-up below hands those to the canvas. A canvas CARD is
      // the other half of the rule and stays down there, because a card only owns its wheel once you
      // have clicked into it.
      const windowEl = (e.target as HTMLElement | null)?.closest?.(APP_WINDOW_SELECTOR) as HTMLElement | null;
      if (windowEl && !canvasOwnsGesture && !(e.ctrlKey || e.metaKey)) {
        gesture.owner = windowEl;
        gesture.at = Date.now();
        return;
      }
      // ctrl/cmd wheel is the zoom gesture on every surface: a physically held key or a trackpad pinch (which also sets ctrlKey). It bypasses scrollable children so zoom is always reachable, even over a chat you're typing in.
      const isModifierWheel = e.ctrlKey || e.metaKey;
      // The setting swaps which of the two a bare mouse notch does. A PINCH must keep zooming
      // whatever the setting says: it sets ctrlKey but there is no key held, and nobody pinches to
      // scroll. So only a real held key counts as the swap trigger, and `e.ctrlKey && !isPinch`
      // cannot be used here because Chromium reports a pinch identically to ctrl+wheel; the
      // trackpad classifier is what tells them apart.
      const wheelZooms = wheelActionRef.current !== 'scroll';

      // Let scrollable children handle the event when appropriate, but fall through to canvas pan if the child is at its scroll boundary.
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;
      // Classify on EVERY event (even ones a scrollable child swallows) so stream continuity holds when a gesture drifts from a chat onto the canvas.
      const isTrackpadScroll = classifyTrackpad(e, e.deltaX, e.deltaY);
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

        if (cls === 'scrollable' && !isModifierWheel && !canvasOwnsGesture) {
          // Google Maps model: plain scroll acts on the CANVAS over a CARD (chat, scheduled task) UNLESS you've clicked INTO it. Only a card that isn't scroll-focused diverts to the canvas gesture; non-card scrollable UI (dropdowns, menus, nested panels) always scrolls natively, and a focused card scrolls its content.
          const cardEl = target.closest('[data-select-id]');
          const cardId = cardEl?.getAttribute('data-select-id') ?? null;
          if (cardId && cardId !== getScrollFocusedCard()) {
            target = target.parentElement;
            continue;
          }
          // Past this point the gesture belongs to THIS surface for its whole life. Reaching the end
          // of a chat, or swiping sideways in a list that only scrolls down, used to fall through to
          // the canvas and drag the world out from under you; a scroll that starts inside a card now
          // ends inside it. Zoom still gets through, because isModifierWheel never reaches here.
          gesture.owner = target;
          gesture.at = Date.now();
          return;
        }
        target = target.parentElement;
      }
      if (!isModifierWheel) {
        gesture.owner = CANVAS_OWNER;
        gesture.at = Date.now();
      }

      // The canvas is handling this wheel: every "someone else owns it" branch above has already
      // returned, so this is the one point where a pan or a zoom is committed to. Streaming yields
      // to it (ENG-301); a wheel that scrolled a transcript never reaches here and never stalls the
      // answer the user is reading.
      markInteraction();

      e.preventDefault();
      if (inertiaFrameRef.current) {
        cancelAnimationFrame(inertiaFrameRef.current);
        inertiaFrameRef.current = null;
      }

      if (isModifierWheel) {
        // Pinch or held cmd/ctrl → accumulate zoom deltas + last cursor position. factor = 2^(-Σdy·s) which equals the product of per-event factors, so accumulating dy is mathematically identical to applying each event one at a time.
        const rect = el.getBoundingClientRect();
        pendingZoomDy += clamp(dy, -WHEEL_ZOOM_DELTA_CAP, WHEEL_ZOOM_DELTA_CAP);
        pendingZoomCenter = { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
        scheduleWheelFlush();
      } else if (isTrackpadScroll) {
        // Two-finger trackpad scroll → pan both axes, exactly like Google Maps; macOS momentum events ride the same branch so the glide keeps panning.
        pendingPanDx += dx;
        pendingPanDy += dy;
        scheduleWheelFlush();
      } else if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal-dominant mouse scroll (tilt wheel) → pan X. Dominant-axis, so the vertical jitter in a sideways swipe doesn't also zoom.
        pendingPanDx += dx;
        scheduleWheelFlush();
      } else if (wheelZooms) {
        // Mouse-wheel vertical notch → zoom at the cursor (same anchor as pinch) so the point under the pointer grows toward you, not away. Clamp the per-event delta so a discrete notch is a small step, not a lurch.
        const rect = el.getBoundingClientRect();
        pendingZoomDy += clamp(dy, -WHEEL_ZOOM_DELTA_CAP, WHEEL_ZOOM_DELTA_CAP);
        pendingZoomCenter = { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
        scheduleWheelFlush();
      } else {
        // Setting says a wheel scrolls: pan vertically instead. Zoom is still reachable on
        // cmd/ctrl+wheel, which the isModifierWheel branch above already handles, so the two
        // gestures simply trade places rather than one of them going missing.
        pendingPanDy += dy;
        scheduleWheelFlush();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });

    const onForwardedZoom = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const dy = detail.deltaMode === 1 ? detail.deltaY * 40 : detail.deltaY;
      const rect = el.getBoundingClientRect();
      if (inertiaFrameRef.current) {
        cancelAnimationFrame(inertiaFrameRef.current);
        inertiaFrameRef.current = null;
      }
      // Same per-event cap as a host-side notch, so one wheel click inside a guest page is a step, not a lurch.
      pendingZoomDy += clamp(dy, -WHEEL_ZOOM_DELTA_CAP, WHEEL_ZOOM_DELTA_CAP);
      pendingZoomCenter = {
        cx: (detail.clientX ?? 0) - rect.left,
        cy: (detail.clientY ?? 0) - rect.top,
      };
      scheduleWheelFlush();
    };
    window.addEventListener('openswarm:canvas-wheel-zoom', onForwardedZoom);

    // Plain wheel inside a webview can't bubble out either; the preload forwards horizontal-dominant scrolls as a pan when the guest page has nothing to scroll horizontally, plus middle-mouse drag deltas.
    const onForwardedPan = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const dy = detail.deltaMode === 1 ? (detail.deltaY ?? 0) * 40 : (detail.deltaY ?? 0);
      const dx = detail.deltaMode === 1 ? (detail.deltaX ?? 0) * 40 : (detail.deltaX ?? 0);
      if (inertiaFrameRef.current) {
        cancelAnimationFrame(inertiaFrameRef.current);
        inertiaFrameRef.current = null;
      }
      pendingPanDx += dx;
      pendingPanDy += dy;
      scheduleWheelFlush();
    };
    window.addEventListener('openswarm:canvas-wheel-pan', onForwardedPan);

    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('openswarm:canvas-wheel-zoom', onForwardedZoom);
      window.removeEventListener('openswarm:canvas-wheel-pan', onForwardedPan);
      if (wheelRafId != null) cancelAnimationFrame(wheelRafId);
      if (wheelIdleTimer != null) clearTimeout(wheelIdleTimer);
      // Don't leave the flag stuck on if the canvas unmounts mid-gesture.
      setCanvasInteractionActive(false);
    };
  }, [enabled, applyLive, commitLive]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Portaled children (MuiDialog/Menu opened from canvas-hosted components) bubble through the REACT
    // tree, not the DOM: without this guard their clicks started a canvas pan and the preventDefault
    // killed input focus (the "can't click into the Add-connector fields" bug).
    if (e.currentTarget instanceof Node && e.target instanceof Node && !e.currentTarget.contains(e.target)) return;
    // Fullscreen has no canvas nav, period (same rule the wheel handler enforces): a drag that
    // slipped past the fullscreen surface panned the hidden canvas underneath it.
    if (selectFullscreenCardId(store.getState())) return;
    e.preventDefault();
    cancelAnimation();
    cancelInertia();
    setPanCursor(true);
    setCanvasInteractionActive(true);
    velocityHistoryRef.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: stateRef.current.panX,
      panY: stateRef.current.panY,
    };
  }, [cancelAnimation, cancelInertia, setPanCursor]);

  // RAF-coalesce drag pan; setState per event caused "hop hop hop" feel. Velocity history still captures per-event for inertia accuracy.
  const dragRafRef = useRef<number | null>(null);
  const latestDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const flushDrag = useCallback(() => {
    dragRafRef.current = null;
    const start = panStartRef.current;
    const latest = latestDragRef.current;
    if (!start || !latest) return;
    applyLive({
      ...stateRef.current,
      panX: start.panX + latest.dx,
      panY: start.panY + latest.dy,
    });
  }, [applyLive]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    // Velocity history is per-event so inertia stays accurate on mouseup. Cheap; just pushes to a length-5 ring buffer.
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
    // Apply any pending drag delta synchronously so the final position matches where the cursor was released, then drop the scheduled RAF.
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
    setPanCursor(false);
    setCanvasInteractionActive(false);
    // Inertia keeps writing live and commits when it settles; otherwise this gesture ends here.
    if (!didInertia) commitLive();
    // Only spring back if we were actually panning (not on simple clicks)
    if (wasPanning && !didInertia) {
      springBackIfNeeded();
    }
  }, [startInertia, springBackIfNeeded, commitLive, setPanCursor]);

  // Releasing the button OUTSIDE the window means our window never sees the mouseup, so the pan latch
  // stayed armed and the canvas followed the cursor forever, with no way to escape the app (ENG-257).
  // Enumerating exit paths is whack-a-mole, so the last guard is self-healing: any mouse move with no
  // button held while we think we are panning proves the latch is stale, and it clears itself.
  useEffect(() => {
    const release = () => {
      if (panStartRef.current) {
        panStartRef.current = null;
        setPanCursor(false);
        setCanvasInteractionActive(false);
        commitLive();
      }
    };
    const onStrayMove = (e: MouseEvent) => { if (e.buttons === 0) release(); };
    window.addEventListener('mouseup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    window.addEventListener('mousemove', onStrayMove, true);
    return () => {
      window.removeEventListener('mouseup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      window.removeEventListener('mousemove', onStrayMove, true);
    };
  }, [commitLive, setPanCursor]);

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
        setCmdHeld(true);
      }
      if (e.ctrlKey || e.metaKey) {
        // If the last thing you touched was a browser card, +/-/0 zooms THAT page (like a real browser); otherwise it zooms the dashboard canvas.
        const focusedBrowser = getLastInteractedBrowser();
        const browserWv = focusedBrowser ? getWebview(focusedBrowser) : undefined;
        if (e.key === '0') {
          e.preventDefault();
          if (browserWv) applyBrowserZoom(focusedBrowser as string, 0);
          else resetZoomRef.current();
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          if (browserWv) applyBrowserZoom(focusedBrowser as string, 1);
          else zoomInRef.current();
        } else if (e.key === '-') {
          e.preventDefault();
          if (browserWv) applyBrowserZoom(focusedBrowser as string, -1);
          else zoomOutRef.current();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
      if (e.key === 'Meta' || e.key === 'Control') {
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

  // minZoom is for the AUTOMATIC boot fit only: restoring a dashboard that had grown tall used to land
  // at 29% with nothing readable, the same illness revealZoom cured on spawn. The toolbar's own Fit
  // button passes nothing and still fits everything, however far out that is.
  const fitToView = useCallback((minZoom?: number) => {
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
      const child = children[i] as HTMLElement;
      // Skip a kept-alive browser card from another dashboard (parked off-screen): fitting to it pans the canvas right onto it, which is the cross-dashboard bleed. On an empty dashboard this leaves nothing to fit, so the !isFinite reset below restores an identity transform and the off-screen card stays off-screen.
      if (child.getAttribute?.('data-keepalive-hidden') === '1' || child.querySelector?.('[data-keepalive-hidden="1"]')) continue;
      // Overlays (the 1x1 tether SVG anchored at the canvas origin) are not content: counting one dragged every fit toward (0,0) whenever a sub-agent tether existed.
      if (child.getAttribute?.('data-canvas-overlay') === '1') continue;
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
    const newZoom = clamp(Math.min(availW / contentWidth, availH / contentHeight), Math.max(MIN_ZOOM, minZoom ?? MIN_ZOOM), MAX_ZOOM);
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
      centered?: boolean,
      padding?: { x: number; y: number },
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
      const padX = padding?.x ?? FIT_PADDING;
      const padY = padding?.y ?? FIT_PADDING;
      const availW = vRect.width - padX * 2;
      const availH = vRect.height - padY * 2;
      const ceiling = maxZoom ?? MAX_ZOOM;
      const floor = minZoom ?? MIN_ZOOM;
      const targetZoom = clamp(
        Math.min(availW / contentWidth, availH / contentHeight),
        floor,
        ceiling,
      );
      // Centering is right until the zoom floor bites and the content outgrows its margins: then the left
      // edge slides under the dock (or off screen), so never let it start left of the inset.
      const targetPanX = Math.max(
        (vRect.width - contentWidth * targetZoom) / 2 - minX * targetZoom,
        padX - minX * targetZoom,
      );
      // A single card normally top-biases (header up top, no dead space below). On creation we want the opposite: the new card dead-centered "in front of you", so `centered` forces true vertical centering.
      const topBiased = cardRects.length === 1 && !centered;
      const targetPanY = topBiased || contentHeight * targetZoom > vRect.height
        ? padY * 0.4 - minY * targetZoom
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
      centered?: boolean,
      padding?: { x: number; y: number },
    ) => {
      cancelAnimation();

      const target = computeFitTarget(cardRects, maxZoom, minZoom, centered, padding);
      if (!target) {
        // Keep current camera; snapping to (0,0,1) used to desync the minimap.
        if (cardRects.length === 0 || !viewportRef.current) {
          setCanvasState({ panX: 0, panY: 0, zoom: 1 });
        }
        return;
      }

      if (animate) {
        const cur = stateRef.current;
        const dPan = Math.abs(cur.panX - target.panX) + Math.abs(cur.panY - target.panY);
        const dZoom = Math.abs(cur.zoom - target.zoom);
        if (dPan < 5 && dZoom < 0.01) return;
        animateTo(target, FIT_DURATION);
        // Settle pass: cancelAnimation() must be able to cancel it, else back-to-back fitToCards races and the first settle overwrites the second target.
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          const fresh = computeFitTarget(cardRects, maxZoom, minZoom, centered, padding);
          if (!fresh) return;
          const cur2 = stateRef.current;
          const drift =
            Math.abs(cur2.panX - fresh.panX) +
            Math.abs(cur2.panY - fresh.panY) +
            Math.abs(cur2.zoom - fresh.zoom) * 1000;
          if (drift > 8) setCanvasState(fresh);
        }, FIT_SETTLE_DELAY);
      } else {
        setCanvasState(target);
      }
    },
    [cancelAnimation, animateTo, computeFitTarget, setCanvasState],
  );

  // The camera half of Tidy: frame the freshly gridded cards close in (the 200px fit padding was
  // eating a third of the viewport), never below readable, and never magnified past life size.
  const fitTidy = useCallback(
    (cardRects: Array<{ x: number; y: number; width: number; height: number }>) => {
      fitToCards(cardRects, 1, true, TIDY_MIN_ZOOM, false, TIDY_PADDING);
    },
    [fitToCards],
  );

  // Figma-style spawn camera: never zoom IN, never move if the cards are already on screen; otherwise the minimal pan that reveals them, zooming out only when they cannot fit at the current zoom.
  const revealCards = useCallback(
    (cardRects: Array<{ x: number; y: number; width: number; height: number }>) => {
      const viewport = viewportRef.current;
      if (!viewport || cardRects.length === 0) return;
      const v = viewport.getBoundingClientRect();
      if (v.width <= 0 || v.height <= 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of cardRects) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
      }
      if (!isFinite(minX)) return;
      const REVEAL_MARGIN = 48;
      const cur = stateRef.current;
      const fitZoom = Math.min(
        (v.width - REVEAL_MARGIN * 2) / (maxX - minX),
        (v.height - REVEAL_MARGIN * 2) / (maxY - minY),
      );
      // Never auto-zoom below readable: showing every card at 18% is worse than showing the new one at 50%, and the pan below still brings it into view.
      const zoom = clamp(revealZoom(cur.zoom, fitZoom, MIN_ZOOM, MAX_ZOOM), MIN_ZOOM, MAX_ZOOM);
      // If zooming out, keep the viewport-center world point fixed first, then clamp.
      const ratio = zoom / cur.zoom;
      let panX = v.width / 2 - (v.width / 2 - cur.panX) * ratio;
      let panY = v.height / 2 - (v.height / 2 - cur.panY) * ratio;
      const left = minX * zoom + panX, right = maxX * zoom + panX;
      if (left < REVEAL_MARGIN) panX += REVEAL_MARGIN - left;
      else if (right > v.width - REVEAL_MARGIN) panX -= right - (v.width - REVEAL_MARGIN);
      const top = minY * zoom + panY, bottom = maxY * zoom + panY;
      if (top < REVEAL_MARGIN) panY += REVEAL_MARGIN - top;
      else if (bottom > v.height - REVEAL_MARGIN) panY -= bottom - (v.height - REVEAL_MARGIN);
      const cur2 = stateRef.current;
      if (Math.abs(panX - cur2.panX) < 2 && Math.abs(panY - cur2.panY) < 2 && Math.abs(zoom - cur2.zoom) < 0.005) return;
      cancelAnimation();
      animateTo({ panX, panY, zoom }, FIT_DURATION);
    },
    [cancelAnimation, animateTo],
  );

  const handlers = useMemo(() => ({
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
  }), [handleMouseDown, handleMouseMove, handleMouseUp]);

  // Per-frame pan for edge-pan-during-card-drag: live-only, the caller commits when the drag ends.
  const panBy = useCallback((dx: number, dy: number) => {
    const prev = stateRef.current;
    applyLive({ ...prev, panX: prev.panX + dx, panY: prev.panY + dy });
  }, [applyLive]);

  const getLiveState = useCallback((): CanvasState => stateRef.current, []);
  // Dev-only forensic handle: lets a CDP harness compare the live camera against the DOM transform.
  if (process.env.NODE_ENV !== 'production') (window as unknown as Record<string, unknown>).__OSW_LIVE_CAM__ = getLiveState;

  const actions = useMemo(() => ({
    zoomIn, zoomOut, resetZoom, fitToView, fitToCards, fitTidy, revealCards, animateTo, cancelAnimation,
    setState: setCanvasState, panBy, commit: commitLive, syncTransform: applyLiveToDom, getLiveState,
  }), [zoomIn, zoomOut, resetZoom, fitToView, fitToCards, fitTidy, revealCards, animateTo, cancelAnimation, setCanvasState, panBy, commitLive, applyLiveToDom, getLiveState]);

  return {
    ...state,
    spaceHeld,
    cmdHeld,
    viewportRef,
    contentRef,
    gridRef,
    handlers,
    actions,
  } as const;
}

export type CanvasActions = ReturnType<typeof useCanvasControls>['actions'];
