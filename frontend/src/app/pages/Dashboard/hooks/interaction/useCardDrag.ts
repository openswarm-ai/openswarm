import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { moveCards } from '@/shared/state/dashboardLayoutSlice';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';
import type { CanvasActions } from './useCanvasControls';
import { publishLiveDrag } from './liveDragChannel';
import { publishMultiDrag } from './multiDragLiveChannel';
import { setCanvasInteractionActive } from '@/shared/canvasInteractionState';

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseCardDragArgs {
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasActions: CanvasActions;
  selection: Selection;
}

const EDGE_ZONE = 60;
// Px per SECOND, not per frame: per-frame speed doubled on 120Hz displays, which is how edge-pan drags flew way past where users wanted.
const EDGE_MAX_SPEED_PX_S = 360;
const EDGE_MAX_FRAME_MS = 40;

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

  // Per-frame deltas ride multiDragLiveChannel (style writes, zero renders); this flag renders
  // exactly twice per gesture and exists so follower cards suppress their spring on the commit.
  const [multiDragActive, setMultiDragActive] = useState(false);
  const multiDragActiveRef = useRef(false);
  const followIdsRef = useRef<string[]>([]);
  const activeDragCardRef = useRef<string | null>(null);
  const isMultiDragRef = useRef(false);

  // ---- Edge panning during card drag ----
  const edgePanFrameRef = useRef<number | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastEdgeTickMsRef = useRef<number | null>(null);
  const vpRectRef = useRef<DOMRect | null>(null);

  const stopEdgePan = useCallback(() => {
    if (edgePanFrameRef.current !== null) {
      cancelAnimationFrame(edgePanFrameRef.current);
      edgePanFrameRef.current = null;
    }
    lastEdgeTickMsRef.current = null;
    vpRectRef.current = null;
  }, []);

  const tickEdgePan = useCallback(() => {
    const vp = viewportRef.current;
    // Stop only when the card is gone, so a drag that ended without a pointerup can't leave the canvas panning forever.
    if (!vp || !activeDragCardRef.current) {
      edgePanFrameRef.current = null;
      return;
    }

    const now = performance.now();
    // Capped so a background-tab stall can't bank up into one giant jump on the next tick.
    const frameMs = Math.min(now - (lastEdgeTickMsRef.current ?? now), EDGE_MAX_FRAME_MS);
    lastEdgeTickMsRef.current = now;
    const speed = EDGE_MAX_SPEED_PX_S * (frameMs / 1000);

    // Cached at arm time: a live getBoundingClientRect here forces layout every frame, interleaved with the pan's style writes.
    const rect = vpRectRef.current ?? (vpRectRef.current = vp.getBoundingClientRect());
    const { x: mx, y: my } = lastMousePosRef.current;
    const dx = speed * axisIntensity(mx, rect.left, rect.right);
    const dy = speed * axisIntensity(my, rect.top, rect.bottom);

    if (dx !== 0 || dy !== 0) {
      // Live-only write (no React commit per frame); clearDrag commits once when the drag ends. panBy synchronously fans out pan-changed, which re-enters handleCardDragMove; the ref MUST still be non-null here or every tick arms a duplicate rAF and the loop doubles per frame (the 1.7.2 edge-pan lag).
      canvasActions.panBy(dx, dy);
    }

    edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
  }, [viewportRef, canvasActions]);

  const handleCardDragStart = useCallback((id: string, type: CardType) => {
    activeDragCardRef.current = id;
    // Multi only when there is actually company: a lone selected card on this path made every drag after the first pay a setState per frame.
    if (selection.isSelected(id) && selection.selectedArray().length > 1) {
      isMultiDragRef.current = true;
      followIdsRef.current = selection.selectedArray().filter((s) => s.id !== id).map((s) => s.id);
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
    // Arm the webview shield on the first real MOVE, not on pointerdown: a plain click also arms the drag machinery, and shielding then made the click-to-focus camera fit skip (it saw a "drag in progress"), so focusing a card took two clicks. On a real drag the shield still goes up before the pointer travels, so the webview neutralization + no-nudge + release-over-webview fixes all hold. Idempotent add.
    document.body.classList.add('dashboard-marquee-active');
    // Card drags count as canvas interaction: without this, a mid-drag transcript resize re-rendered the whole controller per change (the ResizeObserver bail never engaged).
    setCanvasInteractionActive(true);
    // Start edge panning only once actual dragging begins; a live frame handle means the loop is already running.
    if (edgePanFrameRef.current === null) {
      edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
    }
    if (isMultiDragRef.current) {
      if (!multiDragActiveRef.current) {
        multiDragActiveRef.current = true;
        setMultiDragActive(true);
      }
      publishMultiDrag({ ids: followIdsRef.current, dx, dy });
    }
    if (activeDragCardRef.current) {
      publishLiveDrag({ cardId: activeDragCardRef.current, dx, dy });
    }
  }, [tickEdgePan]);

  const clearDrag = useCallback(() => {
    stopEdgePan();
    // Reconcile React with whatever edge-pan wrote live during the drag.
    canvasActions.commit();
    activeDragCardRef.current = null;
    document.body.classList.remove('dashboard-marquee-active');
    setCanvasInteractionActive(false);
    isMultiDragRef.current = false;
    followIdsRef.current = [];
    publishMultiDrag(null);
    publishLiveDrag(null);
    if (multiDragActiveRef.current) {
      // Stay active through the moveCards commit paint (followers must snap, not spring), then release next frame.
      requestAnimationFrame(() => {
        multiDragActiveRef.current = false;
        setMultiDragActive(false);
      });
    }
  }, [stopEdgePan, canvasActions]);

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
    multiDragActive,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  };
}
