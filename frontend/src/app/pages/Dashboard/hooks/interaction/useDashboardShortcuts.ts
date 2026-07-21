import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { toggleExpandSession } from '@/shared/state/agentsSlice';
import { reopenLastClosed } from '@/shared/state/dashboardLayoutSlice';
import { deleteSelectedCards } from './deleteSelectedCards';
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
    // Cmd on Mac == Ctrl on Windows: collapse both into one "primary" modifier so a shortcut stored
    // as meta+n still fires when a Windows user presses Ctrl+N (matches the metaKey||ctrlKey idiom used
    // by every other handler in this file).
    const needsPrimary = parts.includes('meta') || parts.includes('ctrl');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');

    const handleShortcut = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (e.key.toLowerCase() !== key) return;
      if (needsPrimary !== (e.metaKey || e.ctrlKey)) return;
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
      deleteSelectedCards(selection.selectedIds, dispatch);
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
