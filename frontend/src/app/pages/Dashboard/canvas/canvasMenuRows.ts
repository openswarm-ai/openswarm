import { reopenLastClosed } from '@/shared/state/dashboardLayoutSlice';
import { getClipboardCards } from '@/shared/dashboardClipboard';
import type { AppDispatch } from '@/shared/state/store';
import type { CardMenuRow } from '../desktop/openCardContextMenu';
import { chord } from '../desktop/chord';

interface CanvasMenuArgs {
  dispatch: AppDispatch;
  hasCards: boolean;
  onNewAgent: () => void;
  onAddBrowser: () => void;
  onApplications: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onTidy: () => void;
  onFitToView: () => void;
}

export function canvasMenuRows({
  dispatch, hasCards, onNewAgent, onAddBrowser, onApplications, onPaste, onSelectAll, onTidy, onFitToView,
}: CanvasMenuArgs): CardMenuRow[] {
  return [
    { kind: 'header', label: 'New' },
    { label: 'New chat', onClick: onNewAgent },
    { label: 'New browser', shortcut: chord('mod', 'N'), onClick: onAddBrowser },
    // No shortcut chip: the real Cmd+M opens the toolbar view picker, not this Applications window; a lying chip is worse than none.
    { label: 'Add app', onClick: onApplications },
    { kind: 'separator' },
    { label: 'Paste', shortcut: chord('mod', 'V'), disabled: getClipboardCards().length === 0, onClick: onPaste },
    { label: 'Reopen last closed', shortcut: chord('mod', 'shift', 'T'), onClick: () => { void dispatch(reopenLastClosed()); } },
    { kind: 'separator' },
    { kind: 'header', label: 'Canvas' },
    { label: 'Select all', shortcut: chord('mod', 'A'), disabled: !hasCards, onClick: onSelectAll },
    { label: 'Tidy layout', disabled: !hasCards, onClick: onTidy },
    { label: 'Fit to view', disabled: !hasCards, onClick: onFitToView },
  ];
}
