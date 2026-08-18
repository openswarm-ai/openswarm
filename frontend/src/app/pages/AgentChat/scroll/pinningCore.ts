import type React from 'react';
import { getScrollFocusedCard } from '@/shared/cardScrollFocus';
import { RECHECK_VISIBILITY_EVENT } from '../bubbles/markdownMeasure';

// Private rAF pin/stick internals behind useMessageScroll (the single public scroll API). Each routine
// takes the hook's refs through a typed controller object instead of owning any React state itself, so
// the hook file keeps every declaration (and the effect firing order) while the multi-frame pin loops
// live here. None of this runs meaningfully in jsdom (zero-height layout, no ResizeObserver) — behavior
// is verified in the packaged app.

type RafRef = React.MutableRefObject<number | null>;

export interface PinCtl {
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  lastScrollHeightRef: React.MutableRefObject<number>;
}

// Prevent scroll from leaking into the dashboard canvas when at boundaries.
export function attachWheelBoundaryGuard(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    // Pinch-to-zoom (ctrl/meta + wheel) must reach the canvas viewport so the dashboard zooms when the cursor is over an agent's chat panel. Without this early-out the unconditional stopPropagation below kills ctrl+wheel and the canvas listener never fires.
    if (e.ctrlKey || e.metaKey) return;
    // Horizontal-dominant gestures must also reach the canvas so a sideways swipe pans the dashboard (chat has no horizontal scroll to absorb).
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // Google Maps model: a plain wheel over a chat you haven't clicked INTO belongs to the canvas, so let it through instead of swallowing it here (this is what made zoom look dead over any chat).
    const cardId = el.closest('[data-select-id]')?.getAttribute('data-select-id') ?? null;
    if (cardId && cardId !== getScrollFocusedCard()) return;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const scrollingDown = e.deltaY > 0;
    const scrollingUp = e.deltaY < 0;
    if ((scrollingUp && atTop) || (scrollingDown && atBottom)) {
      e.preventDefault();
    }
    e.stopPropagation();
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  return () => el.removeEventListener('wheel', onWheel);
}

// While a stream is LIVE, pin every frame: smooth-text grows between onStreamGrew callbacks, and the
// callback's own rAF deferral let the bottom drift up to ~100px for several frames. Parks the moment the
// stream ends (the calling effect's cleanup), so idle cost is zero.
export function runLiveStreamPin(ctl: PinCtl): () => void {
  let raf = 0;
  const pin = () => {
    const el = ctl.scrollContainerRef.current;
    if (el && ctl.isAtBottomRef.current && el.scrollHeight !== ctl.lastScrollHeightRef.current) {
      ctl.lastScrollHeightRef.current = el.scrollHeight;
      el.scrollTop = el.scrollHeight;
    }
    raf = requestAnimationFrame(pin);
  };
  raf = requestAnimationFrame(pin);
  return () => cancelAnimationFrame(raf);
}

// Multi-frame jam-to-bottom for the scroll-to-bottom jump. A single scrollTop=scrollHeight lands short
// because the bottom spacer collapses and the freshly-mounted items replace their estimates with real
// measured heights, changing scrollHeight while the jump settles.
export function runBottomJumpPin(ctl: PinCtl, rafRef: RafRef): void {
  if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  let frame = 0;
  const FRAMES = 16; // ~260ms, enough for the window + oversized blocks to settle
  const pin = () => {
    const c = ctl.scrollContainerRef.current;
    if (!c) { rafRef.current = null; return; }
    c.scrollTop = c.scrollHeight;
    ctl.lastScrollHeightRef.current = c.scrollHeight;
    ctl.isAtBottomRef.current = true;
    if (++frame < FRAMES) {
      rafRef.current = requestAnimationFrame(pin);
    } else {
      rafRef.current = null;
      // Jump has settled: re-evaluate oversized message / block visibility synchronously so nothing now in view is stuck as a placeholder.
      c.dispatchEvent(new CustomEvent(RECHECK_VISIBILITY_EVENT));
    }
  };
  pin();
}

// Stream-end re-stick pin window (see the calling effect in useMessageScroll for the full rationale):
// pin to bottom across a short multi-frame window that OVERRIDES the completion-commit's layout-induced
// isAtBottom flip; a genuine user scroll-away gesture during the window aborts the pin. Returns the
// cleanup for the calling effect.
export function runStreamEndRepin(
  el: HTMLElement,
  ctl: PinCtl,
  pinRafRef: RafRef,
  pinAbortRef: React.MutableRefObject<boolean>,
): () => void {
  // Abort the pin only on a deliberate scroll-away gesture, not the layout-induced onScroll the commit itself triggers.
  const onUserScrollAway = (e: Event) => {
    if ((e as WheelEvent).deltaY != null && (e as WheelEvent).deltaY < 0) pinAbortRef.current = true; // wheel up
    else if (e.type === 'touchmove') pinAbortRef.current = true;
  };
  el.addEventListener('wheel', onUserScrollAway, { passive: true });
  el.addEventListener('touchmove', onUserScrollAway, { passive: true });
  let frame = 0;
  const FRAMES = 18; // ~300ms at 60fps, long enough for async highlight/layout
  const pin = () => {
    if (pinAbortRef.current) { cleanup(); return; }
    const c = ctl.scrollContainerRef.current;
    if (c) { c.scrollTop = c.scrollHeight; ctl.lastScrollHeightRef.current = c.scrollHeight; ctl.isAtBottomRef.current = true; }
    if (++frame < FRAMES) { pinRafRef.current = requestAnimationFrame(pin); }
    else cleanup();
  };
  const cleanup = () => {
    el.removeEventListener('wheel', onUserScrollAway);
    el.removeEventListener('touchmove', onUserScrollAway);
    if (pinRafRef.current != null) { cancelAnimationFrame(pinRafRef.current); pinRafRef.current = null; }
  };
  pinRafRef.current = requestAnimationFrame(pin);
  return cleanup;
}

export interface InitialPinCtl extends PinCtl {
  lastVisibleItemRef: React.RefObject<HTMLDivElement>;
  initialPinRafRef: RafRef;
  initialBottomScrollSettledRef: React.MutableRefObject<boolean>;
}

// Initial open-at-bottom pin: scrollIntoView the last mounted item across a few frames while the seed
// slice measures in, then flag settled and hand off to the pixel solver via onSettled.
export function runInitialBottomPin(
  ctl: InitialPinCtl,
  hideScrollButton: () => void,
  onSettled: () => void,
): void {
  let frame = 0;
  const FRAMES = 8;
  const pin = () => {
    const c = ctl.scrollContainerRef.current;
    if (!c) return;
    ctl.lastVisibleItemRef.current?.scrollIntoView({ block: 'end' });
    c.scrollTop = Math.max(0, Math.min(c.scrollTop, c.scrollHeight - c.clientHeight));
    ctl.lastScrollHeightRef.current = c.scrollHeight;
    ctl.isAtBottomRef.current = true;
    hideScrollButton();
    if (++frame < FRAMES) {
      ctl.initialPinRafRef.current = requestAnimationFrame(pin);
    } else {
      ctl.initialPinRafRef.current = null;
      ctl.initialBottomScrollSettledRef.current = true;
      onSettled();
      // Re-evaluate visibility now the open jump has settled, so an oversized newest message isn't left stuck as a placeholder.
      c.dispatchEvent(new CustomEvent(RECHECK_VISIBILITY_EVENT));
    }
  };
  if (ctl.initialPinRafRef.current != null) {
    cancelAnimationFrame(ctl.initialPinRafRef.current);
    ctl.initialPinRafRef.current = null;
  }
  pin();
}

// Unmount cleanup: cancel any in-flight rAF loops.
export function cancelRafRefs(refs: RafRef[]): void {
  for (const r of refs) {
    if (r.current != null) {
      cancelAnimationFrame(r.current);
      r.current = null;
    }
  }
}
