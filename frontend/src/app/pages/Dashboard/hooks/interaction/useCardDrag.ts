import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { moveCards, setTiledCard } from '@/shared/state/dashboardLayoutSlice';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';
import type { CanvasActions } from './useCanvasControls';

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseCardDragArgs {
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasActions: CanvasActions;
  selection: Selection;
}

const EDGE_ZONE = 60;
const EDGE_MAX_SPEED = 8;
// Jam a dragged card into the very edge (inside the pan zone) to snap-tile it. Grazing the 60px
// edge still pans the infinite canvas; only the inner 24px band arms a snap and pauses the pan, so
// the two never fight. Top = fullscreen (macOS drag-to-top), sides = halves, corners = quarters.
const SNAP_BAND = 24;

function snapZoneFor(mx: number, my: number, rect: DOMRect): string | null {
  const nearL = mx <= rect.left + SNAP_BAND;
  const nearR = mx >= rect.right - SNAP_BAND;
  const nearT = my <= rect.top + SNAP_BAND;
  const nearB = my >= rect.bottom - SNAP_BAND;
  if (nearT && nearL) return 'tl';
  if (nearT && nearR) return 'tr';
  if (nearB && nearL) return 'bl';
  if (nearB && nearR) return 'br';
  if (nearT) return 'fullscreen';
  if (nearL) return 'left';
  if (nearR) return 'right';
  return null;  // bottom-center is left alone: the composer + dock live there.
}

// Clamped: an infinite canvas lets the cursor sit arbitrarily far outside the viewport, where an unclamped ramp would scale pan speed with distance instead of saturating.
function axisIntensity(pos: number, lo: number, hi: number): number {
  if (pos < lo + EDGE_ZONE) return Math.min(1, (lo + EDGE_ZONE - pos) / EDGE_ZONE);
  if (pos > hi - EDGE_ZONE) return -Math.min(1, (pos - (hi - EDGE_ZONE)) / EDGE_ZONE);
  return 0;
}

export function useCardDrag({
  viewportRef,
  canvasActions,
  selection,
}: UseCardDragArgs) {
  const dispatch = useAppDispatch();

  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<{ cardId: string; dx: number; dy: number } | null>(null);
  const [snapZone, setSnapZone] = useState<string | null>(null);
  const snapZoneRef = useRef<string | null>(null);
  // Snap only a lone card: dragging one of several selected cards to the edge shouldn't tile just it.
  const snapEligibleRef = useRef(true);
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

    // Snap armed = the card is about to tile at this edge, so freeze the canvas instead of panning.
    if ((dx !== 0 || dy !== 0) && !snapZoneRef.current) {
      // Live-only write (no React commit per frame); clearDrag commits once when the drag ends.
      canvasActions.panBy(dx, dy);
    }

    edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
  }, [viewportRef, canvasActions]);

  const handleCardDragStart = useCallback((id: string, type: CardType) => {
    activeDragCardRef.current = id;
    snapEligibleRef.current = selection.selectedArray().filter((s) => s.id !== id).length === 0;
    if (selection.isSelected(id)) {
      isMultiDragRef.current = true;
    } else {
      // Grabbing an unselected card SELECTS just it (was deselectAll, which left nothing selected, so the next spawn had no anchor and flew to viewport-center far from the card you just moved). Also survives the stale-read where the capture-phase click already selected it.
      selection.selectCard(id, type, false);
      isMultiDragRef.current = false;
    }
  }, [selection]);

  const handleCardDragMove = useCallback((dx: number, dy: number, mouseX?: number, mouseY?: number) => {
    if (mouseX !== undefined && mouseY !== undefined) {
      lastMousePosRef.current = { x: mouseX, y: mouseY };
    }
    // Arm/clear the snap target from the live cursor. Single-card drags only: snapping one card of a
    // multi-selection while the rest move is incoherent.
    const vp = viewportRef.current;
    const nextSnap = (vp && snapEligibleRef.current && mouseX !== undefined && mouseY !== undefined)
      ? snapZoneFor(mouseX, mouseY, vp.getBoundingClientRect())
      : null;
    if (nextSnap !== snapZoneRef.current) {
      snapZoneRef.current = nextSnap;
      setSnapZone(nextSnap);
    }
    // Arm the webview shield on the first real MOVE, not on pointerdown: a plain click also arms the drag machinery, and shielding then made the click-to-focus camera fit skip (it saw a "drag in progress"), so focusing a card took two clicks. On a real drag the shield still goes up before the pointer travels, so the webview neutralization + no-nudge + release-over-webview fixes all hold. Idempotent add.
    document.body.classList.add('dashboard-marquee-active');
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
    // Reconcile React with whatever edge-pan wrote live during the drag.
    canvasActions.commit();
    activeDragCardRef.current = null;
    snapZoneRef.current = null;
    setSnapZone(null);
    document.body.classList.remove('dashboard-marquee-active');
    isMultiDragRef.current = false;
    setMultiDragDelta(null);
    setLiveDragInfo(null);
  }, [stopEdgePan, canvasActions]);

  const handleCardDragEnd = useCallback((dx: number, dy: number, didDrag: boolean) => {
    if (didDrag) report('dashboard', 'card_dragged');
    const snap = snapZoneRef.current;
    const activeId = activeDragCardRef.current;
    if (snap && didDrag && activeId) {
      // Released against the edge: tile the card there instead of leaving it at the drop position.
      dispatch(setTiledCard({ cardId: activeId, zone: snap }));
    } else if (isMultiDragRef.current && didDrag) {
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
    snapZone,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  };
}
