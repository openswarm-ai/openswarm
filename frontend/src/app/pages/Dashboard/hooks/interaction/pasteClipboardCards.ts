import { duplicateSession, expandSession } from '@/shared/state/agentsSlice';
import { addViewCard, pasteBrowserCard, placeCard } from '@/shared/state/dashboardLayoutSlice';
import { store, type AppDispatch } from '@/shared/state/store';
import { getClipboardCards } from '@/shared/dashboardClipboard';
import type { CardType } from '../state/useDashboardSelection';

const PASTE_OFFSET = 40;

interface PasteTargets {
  selectCard: (id: string, type: CardType, additive: boolean) => void;
  deselectAll: () => void;
}

interface PasteArgs {
  dispatch: AppDispatch;
  dashboardId: string;
  expandedSessionIds: string[];
  selection: PasteTargets;
  /** Canvas-space drop point; without it the copies land offset from their originals. */
  at?: { x: number; y: number };
}

export async function pasteClipboardCards({ dispatch, dashboardId, expandedSessionIds, selection, at }: PasteArgs): Promise<void> {
  const copied = getClipboardCards();
  if (copied.length === 0) return;

  // Right-click paste anchors the whole group at the cursor by shifting off the first card's corner.
  const anchorX = copied[0].x;
  const anchorY = copied[0].y;

  selection.deselectAll();
  const newSelection = new Map<string, CardType>();
  // Old agent id -> new pasted id, so a browser copied alongside its agent re-docks under the copy (ENG-250).
  const agentRemap = new Map<string, string>();
  // Agents first so their remap exists before their browsers are pasted, whatever the copy order.
  const ordered = [...copied].sort((a, b) => (a.type === 'agent' ? -1 : 0) - (b.type === 'agent' ? -1 : 0));

  for (const card of ordered) {
    const px = at ? at.x + (card.x - anchorX) : card.x + PASTE_OFFSET;
    const py = at ? at.y + (card.y - anchorY) : card.y - PASTE_OFFSET;

    if (card.type === 'agent') {
      const action = await dispatch(duplicateSession({ sessionId: card.id, dashboardId }));
      if (duplicateSession.fulfilled.match(action)) {
        const newId = action.payload.id;
        agentRemap.set(card.id, newId);
        dispatch(placeCard({ sessionId: newId, x: px, y: py, width: card.width, height: card.height, expandedSessionIds }));
        if (card.expanded) dispatch(expandSession(newId));
        newSelection.set(newId, 'agent');
      }
    } else if (card.type === 'view') {
      // Pasting an app whose card is already open creates a NEW independent instance (own runtime + ports) instead of no-op'ing.
      const outputId = card.id.split('#')[0];
      dispatch(addViewCard({ outputId, expandedSessionIds, x: px, y: py, width: card.width, height: card.height, newInstance: true }));
      const viewCards = store.getState().dashboardLayout.viewCards;
      let pastedKey = outputId;
      for (const [key, vc] of Object.entries(viewCards)) {
        if (vc.output_id === outputId && (vc.instance ?? 1) >= (viewCards[pastedKey]?.instance ?? 1)) pastedKey = key;
      }
      newSelection.set(pastedKey, 'view');
    } else if (card.type === 'browser') {
      const browserId = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const originalOwner = card.meta.spawnedBy as string | undefined;
      const dockTo = originalOwner ? agentRemap.get(originalOwner) ?? null : null;
      dispatch(pasteBrowserCard({
        id: browserId, tabs: card.meta.tabs || [], url: card.meta.url || '',
        x: px, y: py, width: card.width, height: card.height, dockTo,
      }));
      newSelection.set(browserId, 'browser');
    }
  }

  for (const [id, type] of newSelection) selection.selectCard(id, type, true);
}
