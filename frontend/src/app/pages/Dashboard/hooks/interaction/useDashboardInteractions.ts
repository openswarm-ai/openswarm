import React, { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import { isAgentDrivenBrowser } from '@/shared/isAgentDrivenBrowser';
import { expandSession } from '@/shared/state/agentsSlice';
import { bringToFront } from '@/shared/state/dashboardLayoutSlice';
import { setScrollFocusedCard } from '@/shared/cardScrollFocus';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';
import type { useCanvasControls } from './useCanvasControls';

type Selection = ReturnType<typeof useDashboardSelection>;
type Canvas = ReturnType<typeof useCanvasControls>;

const SELECT_ATTR = 'data-select-type';

function isCardTarget(target: EventTarget | null, boundary: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el && el !== boundary) {
    if (el.hasAttribute(SELECT_ATTR)) return true;
    el = el.parentElement;
  }
  return false;
}

const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'WEBVIEW']);

function cardIsDocked(id: string): boolean {
  const dl = store.getState().dashboardLayout;
  return !!(dl.browserCards[id]?.docked_to || dl.viewCards[id]?.docked_to);
}

// True when the press landed on a real control (text field, button, browser URL bar/tabs, note textarea, webview) rather than the card's frame. Walk up ONLY to the card root so a button living above the card never counts.
function pressLandedOnControl(target: EventTarget | null | undefined): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    if (el.hasAttribute(SELECT_ATTR)) return false;
    if (CONTROL_TAGS.has(el.tagName) || el.isContentEditable || el.getAttribute('role') === 'button') return true;
    // Card-chrome zones (browser tab strip + / x / tab-drag, resize handles) select+raise the card but
    // must NOT re-center the camera on it, managing a card's frame or tabs is not a "focus this" gesture.
    if (el.hasAttribute('data-card-control') || (el.classList && el.classList.contains('resize-handle'))) return true;
    el = el.parentElement;
  }
  return false;
}

interface UseDashboardInteractionsArgs {
  canvas: Canvas;
  selection: Selection;
  expandedSessionIds: string[];
  isElementSelectMode: boolean;
  getCardRect: (id: string, type: CardType) => { x: number; y: number; width: number; height: number } | undefined;
  setFocusedCardId: Dispatch<SetStateAction<string | null>>;
}

// Run fn AFTER the next paint (rAF fires just before paint, the timeout lands after it), with a
// plain-timer fallback because rAF freezes in occluded windows. Expanding a chat mounts the whole
// transcript; doing that inside the click handler blocked the pressed frame ~400ms (the INP tail).
function afterPaint(fn: () => void): void {
  let fired = false;
  const run = (): void => { if (!fired) { fired = true; fn(); } };
  window.requestAnimationFrame(() => window.setTimeout(run, 0));
  window.setTimeout(run, 80);
}

export function useDashboardInteractions({
  canvas,
  selection,
  expandedSessionIds,
  isElementSelectMode,
  getCardRect,
  setFocusedCardId,
}: UseDashboardInteractionsArgs) {
  const dispatch = useAppDispatch();

  // Delay single-click collapse so double-click can override
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCardSelect = useCallback((id: string, type: CardType, shiftKey: boolean, originTarget?: EventTarget | null) => {
    report('dashboard', 'card_clicked', { card_type: type, shift: shiftKey });
    if (shiftKey) {
      selection.selectCard(id, type, true);
      return;
    }

    selection.selectCard(id, type, false);
    // Selection paints THIS frame (instant feedback); the z-restack invalidates the whole cards
    // dict and reconciles every card, so it runs after the interaction's paint (INP critical path).
    afterPaint(() => dispatch(bringToFront({ id, type })));

    // Clicking a control INSIDE a card (text field, button, browser URL bar/tabs, note textarea) selects + raises it but must NOT re-center the camera onto it: yanking focus to a card just to click into its input is hostile (same reasoning as the guest-page and Workflows carve-outs). Card frame/body clicks still auto-focus.
    if (pressLandedOnControl(originTarget)) return;

    // The Workflows window fits like any card on frame/header presses; pressLandedOnControl above
    // already keeps taps on its buttons, rows, and inputs from yanking the camera.

    // A tiled (fullscreen/snapped) card is pinned Arc-style: clicking inside it must not collapse
    // it or glide the camera; it leaves the mode via its own controls (yellow, Esc, dock swap).
    if (store.getState().dashboardLayout.tiledCards[id]) return;

    // A docked mini lives INSIDE a chat; getCardRect knows only its undocked home, so a fit here flies the camera to an empty patch of canvas.
    if (cardIsDocked(id)) return;

    // Single-click on an already-expanded chat is focus, never collapse: the old delayed-collapse
    // toggle made a click land, collapse the chat, and force a second click to reopen ("takes
    // multiple clicks"). Collapse lives on the yellow light / Esc / canvas click instead.
    if (type === 'agent' && expandedSessionIds.includes(id)) return;

    // Expand (if not already) + center + zoom + bring to front
    if (type === 'agent') {
      afterPaint(() => dispatch(expandSession(id)));
    }
    setFocusedCardId(id);
    // The capture-phase select fires on pointer DOWN; if the press became a drag (or marquee),
    // re-framing mid-gesture is the "canvas yanks" nudge, so the shield class defers the fit. A slow
    // CLICK with a few px of jitter also arms the shield briefly, which used to abort the fit
    // entirely ("takes multiple clicks to zoom in"), so retry once the gesture settles.
    const tryFit = (attempt: number): void => {
      if (document.body.classList.contains('dashboard-marquee-active')) {
        if (attempt < 3) setTimeout(() => tryFit(attempt + 1), 160);
        return;
      }
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true, type === 'browser' ? 0.8 : undefined);
      setTimeout(() => {
        // Don't blur an input/textarea/contentEditable the user is typing in (e.g. a workflow card's embedded chat); the click that selected the card also focused the field, and blurring it kills the cursor.
        const active = document.activeElement as HTMLElement | null;
        if (!active) return;
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
        active.blur?.();
      }, 150);
    };
    setTimeout(() => tryFit(0), 100);
  }, [selection, getCardRect, canvas.actions, dispatch, expandedSessionIds]);

  const handleBringToFront = useCallback((id: string, type: CardType) => {
    // Deferred past the pointerdown's paint: this fires on EVERY card press and the z-restack was
    // the measured 101ms block inside the 272ms INP; one frame of stacking lag is imperceptible.
    afterPaint(() => dispatch(bringToFront({ id, type })));
    // Pressing ANY part of a card (header, body, composer) focuses it for scrolling, so its content scrolls instead of the canvas zooming (Google Maps model). Fires via onPointerDownCapture on every card, so a click into a chat's composer focuses it even though the body swallows the bubble. Cleared on blank-canvas press.
    setScrollFocusedCard(id);
  }, [dispatch]);

  // A click INSIDE a webview's page never reaches the host DOM; BrowserCard forwards the guest's app-clicked IPC as this event. Select + raise only, no camera fit: you're clicking around inside the page, re-framing the canvas every tap would be hostile (same carve-out as the Workflows window).
  useEffect(() => {
    const onGuestSelect = (e: Event) => {
      const browserId = (e as CustomEvent).detail?.browserId;
      if (typeof browserId !== 'string' || !browserId) return;
      // Mid-drag/marquee a selection change joins the card to the multi-drag (the browser visibly chased the cursor); the shield class is up for exactly that window.
      if (document.body.classList.contains('dashboard-marquee-active')) return;
      // The guest preload fires app-clicked for the AGENT's clicks too; a working agent driving its own page must not steal selection (it also re-anchored spawn-beside onto its browser).
      if (isAgentDrivenBrowser(browserId)) return;
      selection.selectCard(browserId, 'browser', false);
      dispatch(bringToFront({ id: browserId, type: 'browser' }));
      // In-guest clicks never reach the host capture handler, so mark the browser focused here, mainly to UN-focus any chat so scroll over other cards behaves right (the browser's own page scroll/zoom is native regardless).
      setScrollFocusedCard(browserId);
    };
    window.addEventListener('openswarm:browser-guest-select', onGuestSelect);
    return () => window.removeEventListener('openswarm:browser-guest-select', onGuestSelect);
  }, [selection, dispatch]);

  // ---- Viewport event handlers (compose pan + marquee) ----
  // Google Maps model: LEFT drag pans the canvas, RIGHT drag marquee-selects (inverse of a design
  // tool, matching how the user asked for it). Middle keeps panning. The viewport move/up handlers
  // run BOTH pan + marquee every frame, so which one is "armed" is decided here on mousedown.
  const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      canvas.handlers.onMouseDown(e);
      return;
    }

    // RIGHT button = marquee select. preventDefault kills the OS context menu on the canvas.
    if (e.button === 2) {
      e.preventDefault();
      if (isCardTarget(e.target, e.currentTarget)) return;
      selection.handleCanvasMouseDown(e.nativeEvent);
      return;
    }

    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;

    // Clicking blank canvas leaves every card: plain scroll zooms the canvas again (Google Maps model).
    setScrollFocusedCard(null);

    // Canvas click, drop any lingering input focus so arrow-key nav works immediately without the user having to press Escape first.
    const active = document.activeElement as HTMLElement | null;
    const activeTag = active?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || (active as any)?.isContentEditable) {
      active?.blur?.();
    }

    if (isElementSelectMode) {
      if (e.metaKey || e.ctrlKey) {
        canvas.handlers.onMouseDown(e);
      }
      return;
    }

    // meta/ctrl + LEFT keeps a way to marquee-select with the primary button (additive selection);
    // plain LEFT (and space-held) pans. A plain empty-canvas press clears the selection.
    if (e.metaKey || e.ctrlKey) {
      selection.handleCanvasMouseDown(e.nativeEvent);
    } else {
      selection.deselectAll();
      canvas.handlers.onMouseDown(e);
    }
  }, [canvas.handlers, canvas.spaceHeld, selection, isElementSelectMode]);

  const handleViewportMouseMove = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseMove(e);
    selection.handleCanvasMouseMove(e.nativeEvent);
  }, [canvas.handlers, selection]);

  // Reports whether the release ended a marquee drag; the canvas uses that to tell a right-DRAG
  // (rubber band) from a right-CLICK (context menu) without ever arbitrating on mousedown.
  const handleViewportMouseUp = useCallback((e: React.MouseEvent): boolean => {
    canvas.handlers.onMouseUp();
    return selection.handleCanvasMouseUp(e.nativeEvent);
  }, [canvas.handlers, selection]);

  // Double-click empty canvas → zoom OUT anchored at the cursor (Google Maps style). It must never
  // travel: the old fit-all panned the camera to wherever the cards were, which reads as teleporting.
  const handleViewportDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;
    report('dashboard', 'canvas_double_clicked');
    // Double-tap on empty space = show me everything (Eric's call): the same animated fit the
    // overview affordances use, instead of the old blind 0.55x zoom-out that just lost people.
    canvas.actions.fitToView();
  }, [canvas.actions]);

  // Double-click a card → always expand + center + zoom (cancels pending collapse from single-click)
  const handleCardDoubleClick = useCallback((id: string, type: CardType) => {
    report('dashboard', 'card_double_clicked', { card_type: type });
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (type === 'agent') {
      afterPaint(() => dispatch(expandSession(id)));
    }
    dispatch(bringToFront({ id, type }));
    setFocusedCardId(id);
    if (store.getState().dashboardLayout.tiledCards[id]) return;
    if (cardIsDocked(id)) return;
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true);
      setTimeout(() => {
        // Don't blur an input/textarea/contentEditable the user is typing in (e.g. a workflow card's embedded chat); the click that selected the card also focused the field, and blurring it kills the cursor.
        const active = document.activeElement as HTMLElement | null;
        if (!active) return;
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
        active.blur?.();
      }, 150);
    }, 100);
  }, [getCardRect, canvas.actions, dispatch]);

  return {
    handleCardSelect,
    handleBringToFront,
    handleViewportMouseDown,
    handleViewportMouseMove,
    handleViewportMouseUp,
    handleViewportDoubleClick,
    handleCardDoubleClick,
  };
}
