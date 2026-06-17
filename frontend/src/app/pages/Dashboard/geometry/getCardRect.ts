import { store } from '@/shared/state/store';
import type { CardType } from '../hooks/state/useDashboardSelection';

// Reads a card's rect straight from the live Redux store (collapsed height,
// which is what the zoom math wants). Module-level + store.getState() so the
// callback can stay stable across renders.
export function getCardRect(id: string, type: CardType):
  { x: number; y: number; width: number; height: number } | undefined {
  const layoutState = store.getState().dashboardLayout;
  if (type === 'agent') {
    const card = layoutState.cards[id];
    if (!card) return undefined;
    return { x: card.x, y: card.y, width: card.width, height: card.height };
  } else if (type === 'view') {
    const vc = layoutState.viewCards[id];
    if (!vc) return undefined;
    return { x: vc.x, y: vc.y, width: vc.width, height: vc.height };
  } else if (type === 'browser') {
    const bc = layoutState.browserCards[id];
    if (!bc) return undefined;
    return { x: bc.x, y: bc.y, width: bc.width, height: bc.height };
  } else if (type === 'note') {
    const n = layoutState.notes[id];
    if (!n) return undefined;
    return { x: n.x, y: n.y, width: n.width, height: n.height };
  } else if (type === 'workflow') {
    const wc = layoutState.workflowCards[id];
    if (!wc) return undefined;
    return { x: wc.x, y: wc.y, width: wc.width, height: wc.height };
  } else if (type === 'workflows-hub') {
    const hub = layoutState.workflowsHub;
    if (!hub) return undefined;
    return { x: hub.x, y: hub.y, width: hub.width, height: hub.height };
  }
  return undefined;
}
