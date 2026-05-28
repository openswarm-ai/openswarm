import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  duplicateSession,
  expandSession,
  type AgentSession,
} from '@/shared/state/agentsSlice';
import {
  addViewCard,
  pasteBrowserCard,
  placeCard,
  type CardPosition,
  type ViewCardPosition,
  type BrowserCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';
import { setClipboardCards, getClipboardCards, type ClipboardCard } from '@/shared/dashboardClipboard';
import type { CardType, useDashboardSelection } from '../state/useDashboardSelection';

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseDashboardClipboardArgs {
  isActive: boolean;
  dashboardId: string;
  selection: Selection;
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  outputs: Record<string, Output>;
  expandedSessionIds: string[];
}

export function useDashboardClipboard({
  isActive,
  dashboardId,
  selection,
  sessions,
  cards,
  viewCards,
  browserCards,
  outputs,
  expandedSessionIds,
}: UseDashboardClipboardArgs) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const handleCopy = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selection.selectedIds.size === 0) return;

      e.preventDefault();
      const copied: ClipboardCard[] = [];
      const names: string[] = [];
      for (const [id, type] of selection.selectedIds) {
        if (type === 'agent') {
          const session = sessions[id];
          const card = cards[id];
          if (!session || !card) continue;
          copied.push({
            type, id, name: session.name || id,
            meta: { name: session.name, status: session.status, model: session.model, mode: session.mode },
            x: card.x, y: card.y, width: card.width, height: card.height,
            expanded: expandedSessionIds.includes(id),
          });
          names.push(session.name || id);
        } else if (type === 'view') {
          const output = outputs[id];
          const vc = viewCards[id];
          if (!output || !vc) continue;
          copied.push({
            type, id, name: output.name,
            meta: { name: output.name, description: output.description },
            x: vc.x, y: vc.y, width: vc.width, height: vc.height,
          });
          names.push(output.name);
        } else if (type === 'browser') {
          const bc = browserCards[id];
          if (!bc) continue;
          const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId);
          const title = activeTab?.title || 'Browser';
          copied.push({
            type, id, name: title,
            meta: { name: title, url: activeTab?.url || bc.url, tabs: bc.tabs },
            x: bc.x, y: bc.y, width: bc.width, height: bc.height,
          });
          names.push(title);
        }
      }
      setClipboardCards(copied);
      navigator.clipboard.writeText(names.join(', ')).catch(() => {});
    };
    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
  }, [selection.selectedIds, sessions, cards, viewCards, browserCards, outputs, expandedSessionIds]);

  useEffect(() => {
    const PASTE_OFFSET = 40;
    const handlePaste = async (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'v') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      const copied = getClipboardCards();
      if (copied.length === 0) return;
      e.preventDefault();

      selection.deselectAll();
      const newSelection = new Map<string, CardType>();

      for (const card of copied) {
        const px = card.x + PASTE_OFFSET;
        const py = card.y - PASTE_OFFSET;

        if (card.type === 'agent') {
          const action = await dispatch(duplicateSession({ sessionId: card.id, dashboardId }));
          if (duplicateSession.fulfilled.match(action)) {
            const newId = action.payload.id;
            dispatch(placeCard({
              sessionId: newId,
              x: px,
              y: py,
              width: card.width,
              height: card.height,
              expandedSessionIds,
            }));
            if (card.expanded) {
              dispatch(expandSession(newId));
            }
            newSelection.set(newId, 'agent');
          }
        } else if (card.type === 'view') {
          dispatch(addViewCard({ outputId: card.id, expandedSessionIds, x: px, y: py, width: card.width, height: card.height }));
          newSelection.set(card.id, 'view');
        } else if (card.type === 'browser') {
          const browserId = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          dispatch(pasteBrowserCard({
            id: browserId, tabs: card.meta.tabs || [], url: card.meta.url || '',
            x: px, y: py, width: card.width, height: card.height,
          }));
          newSelection.set(browserId, 'browser');
        }
      }

      if (newSelection.size > 0) {
        for (const [id, type] of newSelection) {
          selection.selectCard(id, type, true);
        }
      }
    };
    window.addEventListener('keydown', handlePaste);
    return () => window.removeEventListener('keydown', handlePaste);
  }, [dispatch, dashboardId, expandedSessionIds, selection]);
}
