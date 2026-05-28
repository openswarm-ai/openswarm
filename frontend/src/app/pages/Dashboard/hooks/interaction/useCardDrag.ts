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

export function useCardDrag({
  panX,
  panY,
  zoom,
  viewportRef,
  canvasActions,
  selection,
}: UseCardDragArgs) {
  const dispatch = useAppDispatch();

  // Notify the currently dragging card (if any) that pan/zoom changed so
  // it can re-pin to the cursor. useEffect rather than render-body
  // dispatchEvent: side effects during render are a React anti-pattern
  // and can fire twice in strict mode. Effect runs after commit, so
  // exactly once per real pan/zoom delta. Edge-pan mutates pan via
  // canvasActions.setState below, so the dispatch lives in the same hook.
  useEffect(() => {
    window.dispatchEvent(new Event('openswarm:canvas-pan-changed'));
  }, [panX, panY, zoom]);

  // ---- Edge panning during card drag ----
  const edgePanFrameRef = useRef<number | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Track pan at drag start so cards can compensate for edge-pan offset
  const dragStartPanRef = useRef<{ panX: number; panY: number }>({ panX: 0, panY: 0 });

  const stopEdgePan = useCallback(() => {
    if (edgePanFrameRef.current) {
      cancelAnimationFrame(edgePanFrameRef.current);
      edgePanFrameRef.current = null;
    }
  }, []);

  const tickEdgePan = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const { x: mx, y: my } = lastMousePosRef.current;

    let dx = 0;
    let dy = 0;

    if (mx < rect.left + EDGE_ZONE) {
      dx = EDGE_MAX_SPEED * ((rect.left + EDGE_ZONE - mx) / EDGE_ZONE);
    } else if (mx > rect.right - EDGE_ZONE) {
      dx = -EDGE_MAX_SPEED * ((mx - (rect.right - EDGE_ZONE)) / EDGE_ZONE);
    }
    if (my < rect.top + EDGE_ZONE) {
      dy = EDGE_MAX_SPEED * ((rect.top + EDGE_ZONE - my) / EDGE_ZONE);
    } else if (my > rect.bottom - EDGE_ZONE) {
      dy = -EDGE_MAX_SPEED * ((my - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
    }

    if (dx !== 0 || dy !== 0) {
      canvasActions.setState((prev: { panX: number; panY: number; zoom: number }) => ({
        ...prev,
        panX: prev.panX + dx,
        panY: prev.panY + dy,
      }));
    }

    edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
  }, [viewportRef, canvasActions]);

  // ---- Multi-drag coordination ----
  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<{ cardId: string; dx: number; dy: number } | null>(null);
  const activeDragCardRef = useRef<string | null>(null);
  const isMultiDragRef = useRef(false);

  const edgePanStartedRef = useRef(false);

  const handleCardDragStart = useCallback((id: string, _type: CardType) => {
    activeDragCardRef.current = id;
    edgePanStartedRef.current = false;
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
    // Start edge panning only once actual dragging begins
    if (!edgePanStartedRef.current) {
      edgePanStartedRef.current = true;
      edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
    }
    if (isMultiDragRef.current) {
      setMultiDragDelta({ dx, dy });
    }
    if (activeDragCardRef.current) {
      setLiveDragInfo({ cardId: activeDragCardRef.current, dx, dy });
    }
  }, [tickEdgePan]);

  const handleCardDragEnd = useCallback((dx: number, dy: number, didDrag: boolean) => {
    if (didDrag) report('dashboard', 'card_dragged');
    stopEdgePan();
    if (isMultiDragRef.current && didDrag) {
      const items = selection.selectedArray()
        .filter((s) => s.id !== activeDragCardRef.current);
      if (items.length > 0) {
        dispatch(moveCards({ items, dx, dy }));
      }
    }
    activeDragCardRef.current = null;
    isMultiDragRef.current = false;
    setMultiDragDelta(null);
    setLiveDragInfo(null);
  }, [selection, dispatch, stopEdgePan]);

  // dragStartPanRef is kept for parity with the pre-split inline code; it
  // was wired up for a future edge-pan compensation that never landed.
  void dragStartPanRef;

  return {
    multiDragDelta,
    liveDragInfo,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  };
}
