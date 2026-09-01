import { addViewCard, bringToFront } from '@/shared/state/dashboardLayoutSlice';
import { deleteOutput, type Output } from '@/shared/state/outputsSlice';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import { setClipboardCards } from '@/shared/dashboardClipboard';
import { API_BASE } from '@/shared/config';
import type { AppDispatch } from '@/shared/state/store';
import type { CardMenuRow } from '../desktop/openCardContextMenu';
import { chord } from '../desktop/chord';

interface ViewMenuArgs {
  output: Output;
  cardKey: string;
  dispatch: AppDispatch;
  tileZone?: string;
  isMinimized: boolean;
  card: { x: number; y: number; width: number; height: number };
  onTile: (zone: string) => void;
  onMinimize: () => void;
  onReload: () => void;
  onHardReload: () => void;
  onShare: () => void;
  onClose: () => void;
}

export function viewCardMenuRows({
  output, cardKey, dispatch, tileZone, isMinimized, card,
  onTile, onMinimize, onReload, onHardReload, onShare, onClose,
}: ViewMenuArgs): CardMenuRow[] {
  return [
    { label: 'Open another instance', onClick: () => dispatch(addViewCard({ outputId: output.id, newInstance: true })) },
    { kind: 'separator' },
    { label: tileZone === 'fullscreen' ? 'Exit Full Screen' : 'Full Screen', onClick: () => onTile(tileZone === 'fullscreen' ? 'restore' : 'fullscreen') },
    { label: isMinimized ? 'Restore' : 'Minimize', onClick: onMinimize },
    { label: 'Bring to front', onClick: () => dispatch(bringToFront({ id: cardKey, type: 'view' })) },
    { kind: 'separator' },
    { label: 'Reload', onClick: onReload },
    { label: 'Restart and hard reload', onClick: onHardReload },
    { kind: 'separator' },
    {
      label: 'Copy',
      shortcut: chord('mod', 'C'),
      onClick: () => setClipboardCards([{
        type: 'view', id: cardKey, name: output.name,
        meta: { name: output.name, description: output.description },
        x: card.x, y: card.y, width: card.width, height: card.height,
      }]),
    },
    { label: 'Share or publish...', onClick: onShare },
    // Undoes remembered Always/Never tool decisions; the next call from this app asks again.
    { label: 'Reset tool permissions', onClick: () => { void fetch(`${API_BASE}/apps-sdk/tools/grants/${output.id}`, { method: 'DELETE' }); } },
    { kind: 'separator' },
    { label: 'Close', onClick: onClose },
    {
      label: 'Delete app',
      danger: true,
      onClick: () => {
        // The card has to go first: deleting the output alone leaves a card pointing at nothing.
        void removeViewCardCleanly(cardKey, dispatch).then(() => dispatch(deleteOutput(output.id)));
      },
    },
  ];
}
