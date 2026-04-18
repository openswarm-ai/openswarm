import React, { useState, useRef, useCallback } from 'react';
import { setViewCardPosition } from '@/shared/state/dashboardLayoutSlice';
import { useAppDispatch } from '@/shared/hooks';

const DRAG_THRESHOLD = 3;

interface UseViewCardDragParams {
  cardX: number;
  cardY: number;
  zoom: number;
  outputId: string;
  onDragStart?: (id: string, type: 'agent' | 'view') => void;
  onDragMove?: (dx: number, dy: number) => void;
  onDragEnd?: (dx: number, dy: number, didDrag: boolean) => void;
}

export function useViewCardDrag({
  cardX, cardY, zoom, outputId, onDragStart, onDragMove, onDragEnd,
}: UseViewCardDragParams) {
  const dispatch = useAppDispatch();
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localDragPos, setLocalDragPos] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const justDraggedRef = useRef(false);

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
    didDrag.current = false;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.(outputId, 'view');
  }, [cardX, cardY, onDragStart, outputId]);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const rawDx = e.clientX - dragState.current.startX;
    const rawDy = e.clientY - dragState.current.startY;
    if (!didDrag.current && Math.sqrt(rawDx * rawDx + rawDy * rawDy) < DRAG_THRESHOLD) return;
    didDrag.current = true;
    const dx = rawDx / zoom;
    const dy = rawDy / zoom;
    setLocalDragPos({ x: dragState.current.origX + dx, y: dragState.current.origY + dy });
    onDragMove?.(dx, dy);
  }, [zoom, onDragMove]);

  const handleDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = (e.clientX - dragState.current.startX) / zoom;
    const dy = (e.clientY - dragState.current.startY) / zoom;
    if (didDrag.current) {
      dispatch(setViewCardPosition({
        outputId,
        x: dragState.current.origX + dx,
        y: dragState.current.origY + dy,
      }));
      justDraggedRef.current = true;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
    }
    onDragEnd?.(dx, dy, didDrag.current);
    dragState.current = null;
    didDrag.current = false;
    setLocalDragPos(null);
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [zoom, dispatch, outputId, onDragEnd]);

  return {
    isDragging, localDragPos, justDraggedRef,
    handleDragPointerDown, handleDragPointerMove, handleDragPointerUp,
  };
}
