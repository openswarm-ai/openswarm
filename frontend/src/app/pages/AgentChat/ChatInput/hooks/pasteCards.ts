import { useElementSelection, SelectedElement } from '@/app/components/editor/ElementSelectionContext';
import { getClipboardCards, clearClipboard, type ClipboardCard } from '@/shared/dashboardClipboard';

/** One clipboard card -> the same SelectedElement shape select mode produces; null for kinds context can't hold. */
export function clipboardCardToSelectedElement(card: ClipboardCard): SelectedElement | null {
  const semanticTypeMap: Record<string, SelectedElement['semanticType']> = {
    agent: 'agent-card',
    view: 'view-card',
    browser: 'browser-card',
  };
  const semanticType = semanticTypeMap[card.type];
  if (!semanticType) return null;
  const labelMap: Record<string, string> = {
    'agent-card': 'Agent',
    'view-card': 'View',
    'browser-card': 'Browser',
  };
  const semanticLabel = (labelMap[semanticType] || semanticType) + ': ' + card.name;
  return {
    id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    selectorPath: `[data-select-type="${semanticType}"][data-select-id="${card.id}"]`,
    tagName: 'DIV',
    className: '',
    outerHTML: '',
    computedStyles: {},
    boundingRect: { x: 0, y: 0, width: 0, height: 0 },
    semanticType,
    semanticLabel,
    semanticData: { ...card.meta, selectId: card.id },
  };
}

/** Drains the dashboard clipboard into owner-scoped selected elements. Returns true if it consumed the paste. */
export function tryPasteClipboardCards(elementSelection: ReturnType<typeof useElementSelection>, ownerId: string): boolean {
  const copied = getClipboardCards();
  if (copied.length === 0 || !elementSelection) return false;
  for (const card of copied) {
    const el = clipboardCardToSelectedElement(card);
    if (el) elementSelection.addElementForOwner(ownerId, el);
  }
  clearClipboard();
  return true;
}
