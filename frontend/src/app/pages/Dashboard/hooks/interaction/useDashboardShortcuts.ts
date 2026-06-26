import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { closeSession, toggleExpandSession } from '@/shared/state/agentsSlice';
import { removeNote, removeWorkflowCard, closeWorkflowsHub, recordClosedCard, reopenLastClosed } from '@/shared/state/dashboardLayoutSlice';
import { closeWorkflowCard } from '@/shared/state/workflowsSlice';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { getWebview } from '@/shared/browserRegistry';
import type { useDashboardSelection } from '../state/useDashboardSelection';

type Selection = ReturnType<typeof useDashboardSelection>;

interface UseDashboardShortcutsArgs {
  isActive: boolean;
  newAgentShortcut: string;
  selection: Selection;
  setToolbarOpen: Dispatch<SetStateAction<boolean>>;
  setSearchPaletteOpen: Dispatch<SetStateAction<boolean>>;
}

export function useDashboardShortcuts({
  isActive,
  newAgentShortcut,
  selection,
  setToolbarOpen,
  setSearchPaletteOpen,
}: UseDashboardShortcutsArgs) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const parts = (newAgentShortcut || '').toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needsMeta = parts.includes('meta');
    const needsCtrl = parts.includes('ctrl');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');

    const handleShortcut = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (e.key.toLowerCase() !== key) return;
      if (needsMeta !== e.metaKey) return;
      if (needsCtrl !== e.ctrlKey) return;
      if (needsShift !== e.shiftKey) return;
      if (needsAlt !== e.altKey) return;
      e.preventDefault();
      setToolbarOpen(true);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [newAgentShortcut]);

  useEffect(() => {
    const handleEnter = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (e.key !== 'Enter') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selection.selectedIds.size !== 1) return;
      const [id, type] = selection.selectedIds.entries().next().value!;
      if (type !== 'agent') return;
      e.preventDefault();
      dispatch(toggleExpandSession(id));
    };
    window.addEventListener('keydown', handleEnter);
    return () => window.removeEventListener('keydown', handleEnter);
  }, [selection.selectedIds, dispatch]);

  useEffect(() => {
    const handleDelete = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selection.selectedIds.size === 0) return;
      e.preventDefault();
      const viewIds: string[] = [];
      for (const [id, type] of selection.selectedIds) {
        if (type === 'agent') {
          dispatch(recordClosedCard({ kind: 'agent', id }));
          dispatch(closeSession({ sessionId: id }));
        } else if (type === 'view') {
          dispatch(recordClosedCard({ kind: 'view', id }));
          viewIds.push(id);
        } else if (type === 'browser') {
          dispatch(recordClosedCard({ kind: 'browser', id }));
          removeBrowserCardCleanly(id, dispatch);
        } else if (type === 'note') {
          dispatch(recordClosedCard({ kind: 'note', id }));
          dispatch(removeNote(id));
        } else if (type === 'workflow') {
          dispatch(recordClosedCard({ kind: 'workflow', id }));
          dispatch(removeWorkflowCard(id));
          dispatch(closeWorkflowCard(id));
        } else if (type === 'workflows-hub') {
          dispatch(closeWorkflowsHub());
        }
      }
      // Tear view cards down ONE AT A TIME (each quiesces its GPU surface first); ripping several large app webviews out in one frame is what piles up "non-existent mailbox" errors and kills the GPU process.
      void (async () => { for (const id of viewIds) await removeViewCardCleanly(id, dispatch); })();
      selection.deselectAll();
    };
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [selection, dispatch]);

  // Cmd/Ctrl+Shift+T reopens the most recently closed card (browser, agent, note, app, workflow, or browser tab), like a browser's reopen-closed-tab. The guest-focused case routes through main -> AppShell.
  useEffect(() => {
    const handleReopen = (e: KeyboardEvent) => {
      if (!isActive) return;
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 't') return;
      e.preventDefault();
      dispatch(reopenLastClosed());
    };
    window.addEventListener('keydown', handleReopen);
    return () => window.removeEventListener('keydown', handleReopen);
  }, [isActive, dispatch]);

  // Cmd/Ctrl+A selects every card so it can be deleted in one go. Skipped inside text fields so Cmd+A there still selects text, not cards.
  useEffect(() => {
    const handleSelectAll = (e: KeyboardEvent) => {
      if (!isActive) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      selection.selectAll();
    };
    window.addEventListener('keydown', handleSelectAll);
    return () => window.removeEventListener('keydown', handleSelectAll);
  }, [selection, isActive]);

  // Cmd+F to open card search palette
  useEffect(() => {
    const handleSearch = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      // When you're in a LIVE browser card, Cmd+F is find-in-page (handled in AppShell), not card search. A stale id (its card was closed) must NOT suppress the palette, so require the webview to still exist.
      const fb = getLastInteractedBrowser();
      if (fb && getWebview(fb)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      setSearchPaletteOpen(true);
      report('dashboard', 'search_opened');
    };
    window.addEventListener('keydown', handleSearch);
    return () => window.removeEventListener('keydown', handleSearch);
  }, []);
}
