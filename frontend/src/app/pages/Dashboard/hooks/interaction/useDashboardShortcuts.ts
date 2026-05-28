import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { closeSession, toggleExpandSession } from '@/shared/state/agentsSlice';
import { removeViewCard, removeBrowserCard, removeNote } from '@/shared/state/dashboardLayoutSlice';
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
    const parts = newAgentShortcut.toLowerCase().split('+');
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
      for (const [id, type] of selection.selectedIds) {
        if (type === 'agent') {
          dispatch(closeSession({ sessionId: id }));
        } else if (type === 'view') {
          dispatch(removeViewCard(id));
        } else if (type === 'browser') {
          dispatch(removeBrowserCard(id));
        } else if (type === 'note') {
          dispatch(removeNote(id));
        }
      }
      selection.deselectAll();
    };
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [selection, dispatch]);

  // Cmd+F to open card search palette
  useEffect(() => {
    const handleSearch = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
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
