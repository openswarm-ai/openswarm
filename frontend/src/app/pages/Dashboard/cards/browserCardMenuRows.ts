import { addBrowserTab, bringToFront, recordClosedCard, removeBrowserTab, reopenLastClosed, setActiveBrowserTab, type BrowserTab } from '@/shared/state/dashboardLayoutSlice';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import { setClipboardCards } from '@/shared/dashboardClipboard';
import type { AppDispatch } from '@/shared/state/store';
import type { CardMenuRow } from '../desktop/openCardContextMenu';
import { chord } from '../desktop/chord';

interface BrowserNav {
  reload: () => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface BrowserMenuArgs {
  browserId: string;
  dispatch: AppDispatch;
  tabs: BrowserTab[];
  activeUrl: string;
  activeTitle: string;
  homepage: string;
  tileZone?: string;
  isMinimized: boolean;
  card: { x: number; y: number; width: number; height: number };
  nav: BrowserNav;
  onTile: (zone: string) => void;
  onMinimize: () => void;
  onFind: () => void;
}

export function closeBrowserCard(browserId: string, dispatch: AppDispatch): void {
  dispatch(recordClosedCard({ kind: 'browser', id: browserId }));
  void removeBrowserCardCleanly(browserId, dispatch);
}

export function browserCardMenuRows({
  browserId, dispatch, tabs, activeUrl, activeTitle, homepage, tileZone, isMinimized, card, nav, onTile, onMinimize, onFind,
}: BrowserMenuArgs): CardMenuRow[] {
  return [
    { label: 'New tab', onClick: () => dispatch(addBrowserTab({ browserId, url: homepage })) },
    { label: 'Reopen closed tab', shortcut: chord('mod', 'shift', 'T'), onClick: () => { void dispatch(reopenLastClosed()); } },
    { kind: 'separator' },
    { label: 'Back', disabled: !nav.canGoBack, onClick: nav.back },
    { label: 'Forward', disabled: !nav.canGoForward, onClick: nav.forward },
    { label: 'Reload', onClick: nav.reload },
    { label: 'Find in page', shortcut: chord('mod', 'F'), onClick: onFind },
    { label: 'Copy URL', disabled: !activeUrl, onClick: () => { void navigator.clipboard.writeText(activeUrl); } },
    { kind: 'separator' },
    { label: tileZone === 'fullscreen' ? 'Exit Full Screen' : 'Full Screen', onClick: () => onTile(tileZone === 'fullscreen' ? 'restore' : 'fullscreen') },
    { label: isMinimized ? 'Restore' : 'Minimize', onClick: onMinimize },
    { label: 'Bring to front', onClick: () => dispatch(bringToFront({ id: browserId, type: 'browser' })) },
    {
      label: 'Copy',
      shortcut: chord('mod', 'C'),
      onClick: () => setClipboardCards([{
        type: 'browser', id: browserId, name: activeTitle || 'Browser',
        meta: { name: activeTitle || 'Browser', url: activeUrl, tabs },
        x: card.x, y: card.y, width: card.width, height: card.height,
      }]),
    },
    { kind: 'separator' },
    // Close is recoverable (Cmd+Shift+T reopens); danger styling is reserved for true deletes, matching the agent and app cards.
    { label: 'Close', onClick: () => closeBrowserCard(browserId, dispatch) },
  ];
}

interface TabMenuArgs {
  browserId: string;
  dispatch: AppDispatch;
  tab: BrowserTab;
  tabCount: number;
  homepage: string;
}

export function browserTabMenuRows({ browserId, dispatch, tab, tabCount, homepage }: TabMenuArgs): CardMenuRow[] {
  return [
    { label: 'New tab', onClick: () => dispatch(addBrowserTab({ browserId, url: homepage })) },
    { label: 'Duplicate tab', onClick: () => dispatch(addBrowserTab({ browserId, url: tab.url })) },
    { label: 'Reopen closed tab', shortcut: chord('mod', 'shift', 'T'), onClick: () => { void dispatch(reopenLastClosed()); } },
    { kind: 'separator' },
    { label: 'Copy tab URL', disabled: !tab.url, onClick: () => { void navigator.clipboard.writeText(tab.url); } },
    { label: 'Focus tab', onClick: () => dispatch(setActiveBrowserTab({ browserId, tabId: tab.id })) },
    { kind: 'separator' },
    {
      label: 'Close tab',
      danger: true,
      onClick: () => {
        // Record BEFORE removing: the reducer drops a tab record once the card is down to its last tab.
        if (tabCount <= 1) { closeBrowserCard(browserId, dispatch); return; }
        dispatch(recordClosedCard({ kind: 'tab', id: tab.id, browserId }));
        dispatch(removeBrowserTab({ browserId, tabId: tab.id }));
      },
    },
  ];
}
