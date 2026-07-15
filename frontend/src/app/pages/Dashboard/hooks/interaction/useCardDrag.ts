import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { moveCards } from '@/shared/state/dashboardLayoutSlice';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';
import type { CanvasActions } from './useCanvasControls';

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseCardDragArgs {
  panX: number;
  panY: number;
  zoom: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasActions: CanvasActions;
  selection: Selection;
}

const EDGE_ZONE = 60;
const EDGE_MAX_SPEED = 8;

// Clamped: an infinite canvas lets the cursor sit arbitrarily far outside the viewport, where an unclamped ramp would scale pan speed with distance instead of saturating.
function axisIntensity(pos: number, lo: number, hi: number): number {
  if (pos < lo + EDGE_ZONE) return Math.min(1, (lo + EDGE_ZONE - pos) / EDGE_ZONE);
  if (pos > hi - EDGE_ZONE) return -Math.min(1, (pos - (hi - EDGE_ZONE)) / EDGE_ZONE);
  return 0;
}

export function useCardDrag({
  panX,
  panY,
  zoom,
  viewportRef,
  canvasActions,
  selection,
}: UseCardDragArgs) {
  const dispatch = useAppDispatch();

  // Notify the currently dragging card (if any) that pan/zoom changed so it can re-pin to the cursor. useEffect rather than render-body dispatchEvent: side effects during render are a React anti-pattern and can fire twice in strict mode. Effect runs after commit, so exactly once per real pan/zoom delta. Edge-pan mutates pan via canvasActions.setState below, so the dispatch lives in the same hook.
  useEffect(() => {
    window.dispatchEvent(new Event('openswarm:canvas-pan-changed'));
  }, [panX, panY, zoom]);

  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<{ cardId: string; dx: number; dy: number } | null>(null);
  const activeDragCardRef = useRef<string | null>(null);
  const isMultiDragRef = useRef(false);

  // ---- Edge panning during card drag ----
  const edgePanFrameRef = useRef<number | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const stopEdgePan = useCallback(() => {
    if (edgePanFrameRef.current !== null) {
      cancelAnimationFrame(edgePanFrameRef.current);
      edgePanFrameRef.current = null;
    }
  }, []);

  const tickEdgePan = useCallback(() => {
    edgePanFrameRef.current = null;
    const vp = viewportRef.current;
    // Re-arm only while a card is still held, so a drag that ended without a pointerup can't leave the canvas panning forever.
    if (!vp || !activeDragCardRef.current) return;

    const rect = vp.getBoundingClientRect();
    const { x: mx, y: my } = lastMousePosRef.current;
    const dx = EDGE_MAX_SPEED * axisIntensity(mx, rect.left, rect.right);
    const dy = EDGE_MAX_SPEED * axisIntensity(my, rect.top, rect.bottom);

    if (dx !== 0 || dy !== 0) {
      canvasActions.setState((prev: { panX: number; panY: number; zoom: number }) => ({
        ...prev,
        panX: prev.panX + dx,
        panY: prev.panY + dy,
      }));
    }

    edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
  }, [viewportRef, canvasActions]);

  const handleCardDragStart = useCallback((id: string, _type: CardType) => {
    activeDragCardRef.current = id;
    if (selection.isSelected(id)) {
      isMultiDragRef.current = true;
    } else {
      selection.deselectAll();
      isMultiDragRef.current = false;
    }
  }, [selection]);

  const handleCardDragMove = useCallback((dx: number, dy: number, mouseX?: number, mouseY?: number) => {
    if (mouseX !== undefined && mouseY !== undefined) {
      lastMousePosRef.current = { x: mouseX, y: mouseY };
    }
    // Start edge panning only once actual dragging begins; a live frame handle means the loop is already running.
    if (edgePanFrameRef.current === null) {
      edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
    }
    if (isMultiDragRef.current) {
      setMultiDragDelta({ dx, dy });
    }
    if (activeDragCardRef.current) {
      setLiveDragInfo({ cardId: activeDragCardRef.current, dx, dy });
    }
  }, [tickEdgePan]);

  const clearDrag = useCallback(() => {
    stopEdgePan();
    activeDragCardRef.current = null;
    isMultiDragRef.current = false;
    setMultiDragDelta(null);
    setLiveDragInfo(null);
  }, [stopEdgePan]);

  const handleCardDragEnd = useCallback((dx: number, dy: number, didDrag: boolean) => {
    if (didDrag) report('dashboard', 'card_dragged');
    if (isMultiDragRef.current && didDrag) {
      const items = selection.selectedArray()
        .filter((s) => s.id !== activeDragCardRef.current);
      if (items.length > 0) {
        dispatch(moveCards({ items, dx, dy }));
      }
    }
    clearDrag();
  }, [selection, dispatch, clearDrag]);

  // Backstop: a pointercancel or a lost pointer capture never reaches the card's onDragEnd, which would otherwise strand the drag with the rAF above panning forever. A normal release runs the card's commit first, since React delegates to the root container and this fires as the event bubbles on past it.
  useEffect(() => {
    const abortDrag = () => {
      if (activeDragCardRef.current) clearDrag();
    };
    window.addEventListener('pointerup', abortDrag);
    window.addEventListener('pointercancel', abortDrag);
    return () => {
      window.removeEventListener('pointerup', abortDrag);
      window.removeEventListener('pointercancel', abortDrag);
      stopEdgePan();
    };
  }, [clearDrag, stopEdgePan]);

  return {
    multiDragDelta,
    liveDragInfo,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  };
}
