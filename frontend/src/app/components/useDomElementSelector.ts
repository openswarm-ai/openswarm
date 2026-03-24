import { useEffect, useRef, useState, useCallback } from 'react';
import { SelectedElement, useElementSelection } from './ElementSelectionContext';

const SELECT_ATTR = 'data-select-type';
const SELECT_ID_ATTR = 'data-select-id';
const SELECT_META_ATTR = 'data-select-meta';

const DRAG_SELECT_TYPES = ['agent-card', 'view-card', 'browser-card'] as const;
const DRAG_SELECTOR = DRAG_SELECT_TYPES.map((t) => `[${SELECT_ATTR}="${t}"]`).join(',');

export interface OverlayState {
  visible: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
  label: string;
}

export interface DragRect {
  visible: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
}

const EMPTY_OVERLAY: OverlayState = { visible: false, top: 0, left: 0, width: 0, height: 0, label: '' };
const EMPTY_DRAG: DragRect = { visible: false, top: 0, left: 0, width: 0, height: 0 };

const SEMANTIC_LABELS: Record<string, string> = {
  'agent-card': 'Agent',
  'message': 'Message',
  'tool-call': 'Tool Call',
  'tool-group': 'Tool Group',
  'view-card': 'View',
  'browser-card': 'Browser',
};

function findSelectableAncestor(target: Element, excludeId?: string | null): Element | null {
  let current: Element | null = target;
  while (current) {
    if (current.hasAttribute(SELECT_ATTR)) {
      if (excludeId && current.getAttribute(SELECT_ID_ATTR) === excludeId) return null;
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function buildSemanticLabel(type: string, meta: Record<string, any>): string {
  const prefix = SEMANTIC_LABELS[type] || type;
  if (meta.name) return `${prefix}: ${meta.name}`;
  if (meta.role && meta.content) {
    const truncated = String(meta.content).slice(0, 40);
    return `${prefix} (${meta.role}): ${truncated}${String(meta.content).length > 40 ? '…' : ''}`;
  }
  if (meta.label) return `${prefix}: ${meta.label}`;
  if (meta.tool) return `${prefix}: ${meta.tool}`;
  return prefix;
}

function rectsIntersect(
  a: { top: number; left: number; bottom: number; right: number },
  b: { top: number; left: number; bottom: number; right: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function buildSelectedElement(el: Element): SelectedElement {
  const type = el.getAttribute(SELECT_ATTR) || '';
  const selectId = el.getAttribute(SELECT_ID_ATTR) || '';
  let meta: Record<string, any> = {};
  try { meta = JSON.parse(el.getAttribute(SELECT_META_ATTR) || '{}'); } catch {}
  const rect = el.getBoundingClientRect();
  const semanticLabel = buildSemanticLabel(type, meta);

  return {
    id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    selectorPath: `[${SELECT_ATTR}="${type}"][${SELECT_ID_ATTR}="${selectId}"]`,
    tagName: el.tagName,
    className: '',
    outerHTML: '',
    computedStyles: {},
    boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    semanticType: type as SelectedElement['semanticType'],
    semanticLabel,
    semanticData: { ...meta, selectId },
  };
}

export interface DragPreviewElement {
  selectId: string;
  top: number;
  left: number;
  width: number;
  height: number;
  label: string;
  action: 'add' | 'remove';
}

const DRAG_THRESHOLD = 5;

export interface DomSelectorState {
  overlay: OverlayState;
  dragRect: DragRect;
  dragPreview: DragPreviewElement[];
}

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
    // If we're drawing a drag rectangle, update it instead of hover overlay
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
          const allSelectables = document.querySelectorAll(DRAG_SELECTOR);
          const preview: DragPreviewElement[] = [];
          const seen = new Set<string>();
          const excId = excludeIdRef.current;
          allSelectables.forEach((el) => {
            const selectId = el.getAttribute(SELECT_ID_ATTR) || '';
            if (excId && selectId === excId) return;
            const rect = el.getBoundingClientRect();
            if (rectsIntersect(b, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })) {
              if (seen.has(selectId)) return;
              seen.add(selectId);
              const type = el.getAttribute(SELECT_ATTR) || '';
              let meta: Record<string, any> = {};
              try { meta = JSON.parse(el.getAttribute(SELECT_META_ATTR) || '{}'); } catch {}
              preview.push({
                selectId,
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                label: buildSemanticLabel(type, meta),
                action: selectedIdsRef.current.has(selectId) ? 'remove' : 'add',
              });
            }
          });
          setDragPreview(preview);
        });
      }
      return;
    }

    const target = e.target as Element;
    if (!target) {
      setOverlay(EMPTY_OVERLAY);
      hoveredRef.current = null;
      return;
    }

    if (target.tagName === 'IFRAME') {
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
      let meta: Record<string, any> = {};
      try { meta = JSON.parse(selectable.getAttribute(SELECT_META_ATTR) || '{}'); } catch {}
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

      const allSelectables = document.querySelectorAll(DRAG_SELECTOR);
      const processed = new Set<string>();

      const excId = excludeIdRef.current;
      allSelectables.forEach((el) => {
        const selectId = el.getAttribute(SELECT_ID_ATTR) || '';
        if (excId && selectId === excId) return;
        const rect = el.getBoundingClientRect();
        const elRect = {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };

        if (rectsIntersect(dr, elRect)) {
          if (processed.has(selectId)) return;
          processed.add(selectId);

          const existingId = selectedIdsRef.current.get(selectId);
          if (existingId) {
            ctx.removeSelectedElement(existingId);
          } else {
            ctx.addSelectedElement(buildSelectedElement(el));
          }
        }
      });
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
    if (!ctx?.selectMode) {
      setOverlay(EMPTY_OVERLAY);
      setDragRect(EMPTY_DRAG);
      setDragPreview([]);
      hoveredRef.current = null;
      dragOriginRef.current = null;
      dragBoundsRef.current = null;
      isDraggingRef.current = false;
      preDragFocusRef.current = null;
      return;
    }

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
