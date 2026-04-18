import { type SelectedElement } from '@/app/pages/Dashboard/_shared/element_selection/SelectedElement';
import { type OverlayState, type DragRect, type DragPreviewElement } from '@/app/pages/Dashboard/_shared/types';

export const SELECT_ATTR = 'data-select-type';
export const SELECT_ID_ATTR = 'data-select-id';
export const SELECT_META_ATTR = 'data-select-meta';

const DRAG_SELECT_TYPES = ['agent-card', 'view-card', 'browser-card'] as const;
const DRAG_SELECTOR = DRAG_SELECT_TYPES.map((t) => `[${SELECT_ATTR}="${t}"]`).join(',');

export const EMPTY_OVERLAY: OverlayState = { visible: false, top: 0, left: 0, width: 0, height: 0, label: '' };
export const EMPTY_DRAG: DragRect = { visible: false, top: 0, left: 0, width: 0, height: 0 };

export interface SelectMeta {
  name?: string;
  role?: string;
  content?: string;
  label?: string;
  tool?: string;
  [key: string]: unknown;
}

const SEMANTIC_LABELS: Record<string, string> = {
  'agent-card': 'Agent',
  'message': 'Message',
  'tool-call': 'Tool Call',
  'tool-group': 'Tool Group',
  'view-card': 'View',
  'browser-card': 'Browser',
};

export function findSelectableAncestor(target: Element, excludeId?: string | null): Element | null {
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

export function buildSemanticLabel(type: string, meta: SelectMeta): string {
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

export function buildSelectedElement(el: Element): SelectedElement {
  const type = el.getAttribute(SELECT_ATTR) || '';
  const selectId = el.getAttribute(SELECT_ID_ATTR) || '';
  let meta: SelectMeta = {};
  try { meta = JSON.parse(el.getAttribute(SELECT_META_ATTR) || '{}'); } catch { /* malformed JSON defaults to empty object */ }
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

export const DRAG_THRESHOLD = 5;

export interface DomSelectorState {
  overlay: OverlayState;
  dragRect: DragRect;
  dragPreview: DragPreviewElement[];
}

export function computeDragPreview(
  bounds: { left: number; top: number; right: number; bottom: number },
  excludeId: string | null,
  selectedIds: Map<string, string>,
): DragPreviewElement[] {
  const allSelectables = document.querySelectorAll(DRAG_SELECTOR);
  const preview: DragPreviewElement[] = [];
  const seen = new Set<string>();
  allSelectables.forEach((el) => {
    const selectId = el.getAttribute(SELECT_ID_ATTR) || '';
    if (excludeId && selectId === excludeId) return;
    const rect = el.getBoundingClientRect();
    if (rectsIntersect(bounds, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })) {
      if (seen.has(selectId)) return;
      seen.add(selectId);
      const type = el.getAttribute(SELECT_ATTR) || '';
      let meta: SelectMeta = {};
      try { meta = JSON.parse(el.getAttribute(SELECT_META_ATTR) || '{}'); } catch { /* malformed JSON defaults to empty object */ }
      preview.push({
        selectId,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        label: buildSemanticLabel(type, meta),
        action: selectedIds.has(selectId) ? 'remove' : 'add',
      });
    }
  });
  return preview;
}

export function processDragSelection(
  dragRect: { left: number; top: number; right: number; bottom: number },
  excludeId: string | null,
  selectedIds: Map<string, string>,
  addElement: (el: SelectedElement) => void,
  removeElement: (id: string) => void,
): void {
  const allSelectables = document.querySelectorAll(DRAG_SELECTOR);
  const processed = new Set<string>();
  allSelectables.forEach((el) => {
    const selectId = el.getAttribute(SELECT_ID_ATTR) || '';
    if (excludeId && selectId === excludeId) return;
    const rect = el.getBoundingClientRect();
    const elRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    if (rectsIntersect(dragRect, elRect)) {
      if (processed.has(selectId)) return;
      processed.add(selectId);
      const existingId = selectedIds.get(selectId);
      if (existingId) {
        removeElement(existingId);
      } else {
        addElement(buildSelectedElement(el));
      }
    }
  });
}
