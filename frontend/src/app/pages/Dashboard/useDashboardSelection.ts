import { useState, useCallback, useRef, useEffect, RefObject } from 'react';
import type { CardPosition, ViewCardPosition } from '@/shared/state/dashboardLayoutSlice';

export type CardType = 'agent' | 'view';

export interface SelectedCard {
  id: string;
  type: CardType;
}

export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenToCanvas {
  panX: number;
  panY: number;
  zoom: number;
  viewportRef: RefObject<HTMLDivElement | null>;
}

const DRAG_THRESHOLD = 4;

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function useDashboardSelection(
  canvas: ScreenToCanvas,
  cards: Record<string, CardPosition>,
  viewCards: Record<string, ViewCardPosition>,
) {
  const [selectedIds, setSelectedIds] = useState<Map<string, CardType>>(new Map());
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);

  const marqueeOriginRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const isDraggingMarqueeRef = useRef(false);
  const shiftHeldRef = useRef(false);
  const selectionBeforeMarqueeRef = useRef<Map<string, CardType>>(new Map());

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number) => {
      const vp = canvas.viewportRef.current;
      if (!vp) return { x: 0, y: 0 };
      const rect = vp.getBoundingClientRect();
      return {
        x: (screenX - rect.left - canvas.panX) / canvas.zoom,
        y: (screenY - rect.top - canvas.panY) / canvas.zoom,
      };
    },
    [canvas.panX, canvas.panY, canvas.zoom, canvas.viewportRef],
  );

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const deselectAll = useCallback(() => setSelectedIds(new Map()), []);

  const selectCard = useCallback(
    (id: string, type: CardType, shiftKey: boolean) => {
      setSelectedIds((prev) => {
        if (shiftKey) {
          const next = new Map(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.set(id, type);
          }
          return next;
        }
        return new Map([[id, type]]);
      });
    },
    [],
  );

  const selectedArray = useCallback((): SelectedCard[] => {
    return Array.from(selectedIds.entries()).map(([id, type]) => ({ id, type }));
  }, [selectedIds]);

  const computeMarqueeSelection = useCallback(
    (rect: MarqueeRect, shiftKey: boolean) => {
      const intersecting = new Map<string, CardType>();

      for (const card of Object.values(cards)) {
        if (
          rectsIntersect(rect, {
            x: card.x,
            y: card.y,
            width: card.width,
            height: card.height,
          })
        ) {
          intersecting.set(card.session_id, 'agent');
        }
      }

      for (const vc of Object.values(viewCards)) {
        if (
          rectsIntersect(rect, {
            x: vc.x,
            y: vc.y,
            width: vc.width,
            height: vc.height,
          })
        ) {
          intersecting.set(vc.output_id, 'view');
        }
      }

      if (shiftKey) {
        const base = selectionBeforeMarqueeRef.current;
        const next = new Map(base);
        for (const [id, type] of intersecting) {
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.set(id, type);
          }
        }
        return next;
      }

      return intersecting;
    },
    [cards, viewCards],
  );

  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;

      marqueeOriginRef.current = { screenX: e.clientX, screenY: e.clientY };
      isDraggingMarqueeRef.current = false;
      shiftHeldRef.current = e.shiftKey;
      selectionBeforeMarqueeRef.current = new Map(selectedIds);
    },
    [selectedIds],
  );

  const handleCanvasMouseMove = useCallback(
    (e: MouseEvent) => {
      const origin = marqueeOriginRef.current;
      if (!origin) return;

      const dx = e.clientX - origin.screenX;
      const dy = e.clientY - origin.screenY;

      if (!isDraggingMarqueeRef.current) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        isDraggingMarqueeRef.current = true;
      }

      const start = screenToCanvas(origin.screenX, origin.screenY);
      const end = screenToCanvas(e.clientX, e.clientY);

      const rect: MarqueeRect = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };

      setMarquee(rect);
      setSelectedIds(computeMarqueeSelection(rect, shiftHeldRef.current));
    },
    [screenToCanvas, computeMarqueeSelection],
  );

  const handleCanvasMouseUp = useCallback(
    (e: MouseEvent) => {
      const origin = marqueeOriginRef.current;
      if (!origin) return;

      if (!isDraggingMarqueeRef.current) {
        if (!e.shiftKey) {
          deselectAll();
        }
      }

      marqueeOriginRef.current = null;
      isDraggingMarqueeRef.current = false;
      setMarquee(null);
    },
    [deselectAll],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        deselectAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deselectAll]);

  return {
    selectedIds,
    selectedArray,
    marquee,
    isSelected,
    selectCard,
    deselectAll,
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasMouseUp,
  };
}
