import { useState, useCallback, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { moveCards, bringToFront } from '@/shared/state/dashboardLayoutSlice';
import { type CardType } from '@/app/pages/Dashboard/_shared/types';

interface DragSelection {
  isSelected: (id: string) => boolean;
  deselectAll: () => void;
  selectedArray: () => Array<{ id: string; type: CardType }>;
  selectCard: (id: string, type: CardType, shiftKey: boolean) => void;
}

export function useDashboardDrag(selection: DragSelection) {
  const dispatch = useAppDispatch();
  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<{ cardId: string; dx: number; dy: number } | null>(null);
  const activeDragCardRef = useRef<string | null>(null);
  const isMultiDragRef = useRef(false);

  const handleCardDragStart = useCallback((id: string, _type: CardType) => {
    activeDragCardRef.current = id;
    if (selection.isSelected(id)) {
      isMultiDragRef.current = true;
    } else {
      selection.deselectAll();
      isMultiDragRef.current = false;
    }
  }, [selection]);

  const handleCardDragMove = useCallback((dx: number, dy: number) => {
    if (isMultiDragRef.current) setMultiDragDelta({ dx, dy });
    if (activeDragCardRef.current) {
      setLiveDragInfo({ cardId: activeDragCardRef.current, dx, dy });
    }
  }, []);

  const handleCardDragEnd = useCallback((dx: number, dy: number, didDrag: boolean) => {
    if (isMultiDragRef.current && didDrag) {
      const items = selection.selectedArray()
        .filter((s) => s.id !== activeDragCardRef.current);
      if (items.length > 0) dispatch(moveCards({ items, dx, dy }));
    }
    activeDragCardRef.current = null;
    isMultiDragRef.current = false;
    setMultiDragDelta(null);
    setLiveDragInfo(null);
  }, [selection, dispatch]);

  const handleCardSelect = useCallback((id: string, type: CardType, shiftKey: boolean) => {
    selection.selectCard(id, type, shiftKey);
  }, [selection]);

  const handleBringToFront = useCallback((id: string, type: CardType) => {
    dispatch(bringToFront({ id, type }));
  }, [dispatch]);

  return {
    multiDragDelta,
    liveDragInfo,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
    handleCardSelect,
    handleBringToFront,
  };
}
