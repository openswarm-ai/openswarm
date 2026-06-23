import React, { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { collapseSession, expandSession } from '@/shared/state/agentsSlice';
import { bringToFront } from '@/shared/state/dashboardLayoutSlice';
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

interface UseDashboardInteractionsArgs {
  canvas: Canvas;
  selection: Selection;
  expandedSessionIds: string[];
  isElementSelectMode: boolean;
  getCardRect: (id: string, type: CardType) => { x: number; y: number; width: number; height: number } | undefined;
  setFocusedCardId: Dispatch<SetStateAction<string | null>>;
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

  const handleCardSelect = useCallback((id: string, type: CardType, shiftKey: boolean) => {
    report('dashboard', 'card_clicked', { card_type: type, shift: shiftKey });
    if (shiftKey) {
      selection.selectCard(id, type, true);
      return;
    }

    selection.selectCard(id, type, false);
    dispatch(bringToFront({ id, type }));

    // The Workflows window is an app you click around inside, not a card you
    // re-center every tap. Single-click only raises + selects it; double-click
    // still zoom-to-fits (handleCardDoubleClick). Without this, clicking any
    // button inside it yanked the canvas into a re-zoom.
    if (type === 'workflows-hub' || type === 'workflows-monitor') return;

    const alreadyExpanded = type === 'agent' && expandedSessionIds.includes(id);

    if (alreadyExpanded) {
      // Delay single-click collapse so double-click can override.
      // Double-click handler (handleCardDoubleClick) clears clickTimerRef.
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        dispatch(collapseSession(id));
      }, 250);
      return;
    }

    // Expand (if not already) + center + zoom + bring to front
    if (type === 'agent') {
      dispatch(expandSession(id));
    }
    setFocusedCardId(id);
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true, type === 'browser' ? 0.8 : undefined);
      setTimeout(() => {
        // Don't blur an input/textarea/contentEditable the user is typing in
        // (e.g. a workflow card's embedded chat); the click that selected the
        // card also focused the field, and blurring it kills the cursor.
        const active = document.activeElement as HTMLElement | null;
        if (!active) return;
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
        active.blur?.();
      }, 150);
    }, 100);
  }, [selection, getCardRect, canvas.actions, dispatch, expandedSessionIds]);

  const handleBringToFront = useCallback((id: string, type: CardType) => {
    dispatch(bringToFront({ id, type }));
  }, [dispatch]);

  // ---- Viewport event handlers (compose pan + marquee) ----
  const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      canvas.handlers.onMouseDown(e);
      return;
    }

    if (e.button === 2) {
      e.preventDefault();
      canvas.handlers.onMouseDown(e);
      return;
    }

    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;

    // Canvas click , drop any lingering input focus so arrow-key nav
    // works immediately without the user having to press Escape first.
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

    if (e.metaKey || e.ctrlKey || canvas.spaceHeld) {
      selection.deselectAll();
      canvas.handlers.onMouseDown(e);
    } else {
      selection.handleCanvasMouseDown(e.nativeEvent);
    }
  }, [canvas.handlers, canvas.spaceHeld, selection, isElementSelectMode]);

  const handleViewportMouseMove = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseMove(e);
    selection.handleCanvasMouseMove(e.nativeEvent);
  }, [canvas.handlers, selection]);

  const handleViewportMouseUp = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseUp();
    selection.handleCanvasMouseUp(e.nativeEvent);
  }, [canvas.handlers, selection]);

  // Double-click empty canvas → fit all cards
  const handleViewportDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;
    report('dashboard', 'canvas_double_clicked');
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
      dispatch(expandSession(id));
    }
    dispatch(bringToFront({ id, type }));
    setFocusedCardId(id);
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true);
      setTimeout(() => {
        // Don't blur an input/textarea/contentEditable the user is typing in
        // (e.g. a workflow card's embedded chat); the click that selected the
        // card also focused the field, and blurring it kills the cursor.
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
