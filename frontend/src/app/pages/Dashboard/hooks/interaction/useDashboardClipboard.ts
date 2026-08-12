import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';
import { setClipboardCards, getClipboardCards, type ClipboardCard } from '@/shared/dashboardClipboard';
import { pasteClipboardCards } from './pasteClipboardCards';
import type { useDashboardSelection } from '../state/useDashboardSelection';

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
  onCopiedToContext?: (copied: ClipboardCard[]) => void;
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
  onCopiedToContext,
}: UseDashboardClipboardArgs) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const handleCopy = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      // Highlighted text owns Cmd+C (OS semantics). Without this, clicking a chat selects the CARD, so copying a highlighted message overwrote the clipboard with the card's NAME (the "I copied text but pasted the chat title" bug).
      const textSel = window.getSelection();
      if (textSel && !textSel.isCollapsed && textSel.toString().trim()) return;
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
          // A chat's browser lives INSIDE it, so copying the agent has to carry it along; selecting a
          // card the user sees as one thing must not paste half of it (ENG-250). Deduped below in case
          // the browser was independently selected too.
          for (const bc of Object.values(browserCards)) {
            if (bc.docked_to !== id && bc.spawned_by !== id) continue;
            const tab = bc.tabs.find((t) => t.id === bc.activeTabId);
            copied.push({
              type: 'browser', id: bc.browser_id, name: tab?.title || 'Browser',
              meta: { name: tab?.title || 'Browser', url: tab?.url || bc.url, tabs: bc.tabs, spawnedBy: id },
              x: bc.x, y: bc.y, width: bc.width, height: bc.height,
            });
          }
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
            // Carry the owning session so a group paste can re-dock the browser under the NEW agent (ENG-250).
            meta: { name: title, url: activeTab?.url || bc.url, tabs: bc.tabs, spawnedBy: bc.docked_to ?? bc.spawned_by ?? null },
            x: bc.x, y: bc.y, width: bc.width, height: bc.height,
          });
          names.push(title);
        }
      }
      // Selecting an agent AND its browser must not paste the browser twice.
      const deduped = copied.filter((c, i) => copied.findIndex((o) => o.type === c.type && o.id === c.id) === i);
      setClipboardCards(deduped);
      navigator.clipboard.writeText(names.join(', ')).catch(() => {});
      // Copy IS attach: the selection lands in the composer as context chips, no select mode, no paste step.
      if (copied.length > 0) onCopiedToContext?.(copied);
    };
    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
  }, [selection.selectedIds, sessions, cards, viewCards, browserCards, outputs, expandedSessionIds, onCopiedToContext]);

  useEffect(() => {
    const handlePaste = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'v') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (getClipboardCards().length === 0) return;
      e.preventDefault();
      void pasteClipboardCards({ dispatch, dashboardId, expandedSessionIds, selection });
    };
    window.addEventListener('keydown', handlePaste);
    return () => window.removeEventListener('keydown', handlePaste);
  }, [dispatch, dashboardId, expandedSessionIds, selection, isActive]);
}
