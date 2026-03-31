import { useEffect, useRef, useState, useCallback } from 'react';
import { useElementSelection } from './ElementSelectionContext';
import {
  type OverlayState, type DragRect, type DragPreviewElement, type DomSelectorState, type SelectMeta,
  EMPTY_OVERLAY, EMPTY_DRAG, DRAG_THRESHOLD,
  SELECT_ATTR, SELECT_ID_ATTR, SELECT_META_ATTR,
  findSelectableAncestor, buildSemanticLabel, buildSelectedElement,
  computeDragPreview, processDragSelection,
} from './domSelectorHelpers';

export type { OverlayState, DragRect, DragPreviewElement } from './domSelectorHelpers';

export function useDomElementSelector(): DomSelectorState {
  const ctx = useElementSelection();
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [dragRect, setDragRect] = useState<DragRect>(EMPTY_DRAG);
  const [dragPreview, setDragPreview] = useState<DragPreviewElement[]>([]);
  const hoveredRef = useRef<Element | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragPreviewRafRef = useRef<number | null>(null);

  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const dragBoundsRef = useRef<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const preDragFocusRef = useRef<HTMLElement | null>(null);

  const excludeIdRef = useRef<string | null>(null);
  useEffect(() => {
    excludeIdRef.current = ctx?.excludeSelectId ?? null;
  }, [ctx?.excludeSelectId]);

  const selectedIdsRef = useRef(new Map<string, string>());
  useEffect(() => {
    const map = new Map<string, string>();
    for (const el of (ctx?.selectedElements ?? [])) {
      if (el.semanticData?.selectId) {
        map.set(el.semanticData.selectId as string, el.id);
      }
    }
    selectedIdsRef.current = map;
  }, [ctx?.selectedElements]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (dragOriginRef.current) {
      const origin = dragOriginRef.current;
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;

      if (!isDraggingRef.current && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        isDraggingRef.current = true;
      }

      if (isDraggingRef.current) {
        const bounds = {
          left: Math.min(origin.x, e.clientX),
          top: Math.min(origin.y, e.clientY),
          right: Math.max(origin.x, e.clientX),
          bottom: Math.max(origin.y, e.clientY),
        };
        dragBoundsRef.current = bounds;

        setOverlay(EMPTY_OVERLAY);
        setDragRect({
          visible: true,
          left: bounds.left,
          top: bounds.top,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
        });

        if (dragPreviewRafRef.current) cancelAnimationFrame(dragPreviewRafRef.current);
        dragPreviewRafRef.current = requestAnimationFrame(() => {
          const b = dragBoundsRef.current;
          if (!b) return;
          setDragPreview(computeDragPreview(b, excludeIdRef.current, selectedIdsRef.current));
        });
      }
      return;
    }

    const target = e.target as Element;
    if (!target || target.tagName === 'IFRAME') {
      setOverlay(EMPTY_OVERLAY);
      hoveredRef.current = null;
      return;
    }

    const selectable = findSelectableAncestor(target, excludeIdRef.current);
    if (!selectable) {
      setOverlay(EMPTY_OVERLAY);
      hoveredRef.current = null;
      return;
    }

    hoveredRef.current = selectable;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const rect = selectable.getBoundingClientRect();
      const type = selectable.getAttribute(SELECT_ATTR) || '';
      let meta: SelectMeta = {};
      try { meta = JSON.parse(selectable.getAttribute(SELECT_META_ATTR) || '{}'); } catch { /* malformed meta */ }
      const label = buildSemanticLabel(type, meta);
      setOverlay({
        visible: true,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        label,
      });
    });
  }, []);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey) return;
    const target = e.target as Element;
    if (target && findSelectableAncestor(target, excludeIdRef.current)) {
      e.preventDefault();
      return;
    }
    preDragFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dragOriginRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = false;
  }, []);

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (!dragOriginRef.current) return;

    if (isDraggingRef.current && ctx) {
      const dr = {
        left: Math.min(dragOriginRef.current.x, e.clientX),
        top: Math.min(dragOriginRef.current.y, e.clientY),
        right: Math.max(dragOriginRef.current.x, e.clientX),
        bottom: Math.max(dragOriginRef.current.y, e.clientY),
      };
      processDragSelection(
        dr,
        excludeIdRef.current,
        selectedIdsRef.current,
        ctx.addSelectedElement,
        ctx.removeSelectedElement,
      );
    }

    const wasDragging = isDraggingRef.current;
    dragOriginRef.current = null;
    isDraggingRef.current = false;
    dragBoundsRef.current = null;
    setDragRect(EMPTY_DRAG);
    setDragPreview([]);
    if (dragPreviewRafRef.current) cancelAnimationFrame(dragPreviewRafRef.current);
    if (wasDragging && preDragFocusRef.current) {
      preDragFocusRef.current.focus();
    }
    preDragFocusRef.current = null;
  }, [ctx]);

  const handleClick = useCallback((e: MouseEvent) => {
    if (!ctx) return;
    const target = hoveredRef.current;
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();

    const selectId = target.getAttribute(SELECT_ID_ATTR) || '';
    const existing = ctx.selectedElements.find(
      (el) => el.semanticData?.selectId === selectId,
    );
    if (existing) {
      ctx.removeSelectedElement(existing.id);
    } else {
      ctx.addSelectedElement(buildSelectedElement(target));
    }
  }, [ctx]);

  useEffect(() => {
    if (!ctx?.selectMode) return;

    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('click', handleClick, true);

    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      document.removeEventListener('click', handleClick, true);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (dragPreviewRafRef.current) cancelAnimationFrame(dragPreviewRafRef.current);
      setOverlay(EMPTY_OVERLAY);
      setDragRect(EMPTY_DRAG);
      setDragPreview([]);
      hoveredRef.current = null;
      dragOriginRef.current = null;
      dragBoundsRef.current = null;
      isDraggingRef.current = false;
      preDragFocusRef.current = null;
    };
  }, [ctx?.selectMode, handleMouseMove, handleMouseDown, handleMouseUp, handleClick]);

  return { overlay, dragRect, dragPreview };
}
