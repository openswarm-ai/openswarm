import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  toggleExpandSession,
  expandSession,
} from '@/shared/state/agentsSlice';
import { CLOSE_SESSION, DUPLICATE_SESSION } from '@/shared/backend-bridge/apps/agents';
import {
  removeViewCard,
  removeBrowserCard,
  addViewCard,
  pasteBrowserCard,
  placeCard,
} from '@/shared/state/dashboardLayoutSlice';
import { setClipboardCards, getClipboardCards, type ClipboardCard } from '@/shared/dashboardClipboard';
import type { CardType } from '@/app/pages/Dashboard/types/types';

interface KeyboardDeps {
  newAgentShortcut: string;
  setToolbarOpen: (v: boolean) => void;
  selectedIds: Map<string, CardType>;
  deselectAll: () => void;
  selectCard: (id: string, type: CardType, shiftKey: boolean) => void;
  focusedCardId: string | null;
  setFocusedCardId: (v: string | null) => void;
  handleFocusRequest: (sessionId: string) => void;
  sessions: Record<string, any>;
  cards: Record<string, any>;
  viewCards: Record<string, any>;
  browserCards: Record<string, any>;
  outputs: Record<string, any>;
  expandedSessionIds: string[];
  dashboardId: string | undefined;
}

export function useDashboardKeyboard(deps: KeyboardDeps) {
  const {
    newAgentShortcut, setToolbarOpen, selectedIds, deselectAll, selectCard,
    focusedCardId, setFocusedCardId, handleFocusRequest,
    sessions, cards, viewCards, browserCards, outputs, expandedSessionIds, dashboardId,
  } = deps;
  const dispatch = useAppDispatch();

  useEffect(() => {
    const parts = newAgentShortcut.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needsMeta = parts.includes('meta');
    const needsCtrl = parts.includes('ctrl');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');
    const handleShortcut = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return;
      if (needsMeta !== e.metaKey || needsCtrl !== e.ctrlKey) return;
      if (needsShift !== e.shiftKey || needsAlt !== e.altKey) return;
      e.preventDefault();
      setToolbarOpen(true);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [newAgentShortcut, setToolbarOpen]);

  useEffect(() => {
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selectedIds.size !== 1) return;
      const [id, type] = selectedIds.entries().next().value!;
      if (type !== 'agent') return;
      e.preventDefault();
      dispatch(toggleExpandSession(id));
    };
    window.addEventListener('keydown', handleEnter);
    return () => window.removeEventListener('keydown', handleEnter);
  }, [selectedIds, dispatch]);

  useEffect(() => {
    const handleFocusKeys = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === 'Escape' && focusedCardId) {
        e.preventDefault();
        setFocusedCardId(null);
        return;
      }
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !focusedCardId) {
        if (selectedIds.size !== 1) return;
        const [id, type] = selectedIds.entries().next().value!;
        if (type !== 'agent') return;
        e.preventDefault();
        handleFocusRequest(id);
      }
    };
    window.addEventListener('keydown', handleFocusKeys);
    return () => window.removeEventListener('keydown', handleFocusKeys);
  }, [focusedCardId, selectedIds, handleFocusRequest, setFocusedCardId]);

  useEffect(() => {
    const handleDelete = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selectedIds.size === 0) return;
      e.preventDefault();
      for (const [id, type] of selectedIds) {
        if (type === 'agent') dispatch(CLOSE_SESSION(id));
        else if (type === 'view') dispatch(removeViewCard(id));
        else if (type === 'browser') dispatch(removeBrowserCard(id));
      }
      deselectAll();
    };
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [selectedIds, dispatch, deselectAll]);

  useEffect(() => {
    const handleCopy = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selectedIds.size === 0) return;
      e.preventDefault();
      const copied: ClipboardCard[] = [];
      const names: string[] = [];
      for (const [id, type] of selectedIds) {
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
          const activeTab = bc.tabs.find((t: any) => t.id === bc.activeTabId);
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
  }, [selectedIds, sessions, cards, viewCards, browserCards, outputs, expandedSessionIds]);

  useEffect(() => {
    const PASTE_OFFSET = 40;
    const handlePaste = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'v') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      const copied = getClipboardCards();
      if (copied.length === 0) return;
      e.preventDefault();
      deselectAll();
      const newSelection = new Map<string, CardType>();
      for (const card of copied) {
        const px = card.x + PASTE_OFFSET;
        const py = card.y - PASTE_OFFSET;
        if (card.type === 'agent') {
          const action = await dispatch(DUPLICATE_SESSION(card.id));
          if (DUPLICATE_SESSION.fulfilled.match(action)) {
            const newId = action.payload.session.session_id;
            dispatch(placeCard({ sessionId: newId, x: px, y: py, width: card.width, height: card.height }));
            if (card.expanded) dispatch(expandSession(newId));
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
      for (const [id, type] of newSelection) selectCard(id, type, true);
    };
    window.addEventListener('keydown', handlePaste);
    return () => window.removeEventListener('keydown', handlePaste);
  }, [dispatch, dashboardId, expandedSessionIds, deselectAll, selectCard]);
}
