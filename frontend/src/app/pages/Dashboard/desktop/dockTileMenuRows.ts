import { bringToFront, recordClosedCard, removeCard, removeWorkflowCard, toggleMinimizeCard } from '@/shared/state/dashboardLayoutSlice';
import { closeSession } from '@/shared/state/agentsSlice';
import { copySessionResponse } from '@/shared/copySessionResponse';
import { requestShare } from '@/app/components/share/ShareRequestHost';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import type { AppDispatch } from '@/shared/state/store';
import type { CardMenuRow } from './openCardContextMenu';
import type { DockEntry } from './dockEntries';

export function dockTileMenuRows(entry: DockEntry, dispatch: AppDispatch, onFocus: () => void): CardMenuRow[] {
  return [
    { label: 'Show on canvas', onClick: onFocus },
    { label: 'Bring to front', onClick: () => dispatch(bringToFront({ id: entry.id, type: entry.kind })) },
    // Only kinds the minimized rail actually parks; an agent "minimize" would set a flag nothing reads.
    ...(entry.kind === 'browser' || entry.kind === 'view'
      ? [{ label: 'Minimize', onClick: () => dispatch(toggleMinimizeCard({ cardId: entry.id })) } as CardMenuRow]
      : []),
    ...(entry.kind === 'agent' ? [
      { label: 'Copy response', onClick: () => { copySessionResponse(entry.id); } } as CardMenuRow,
      { label: 'Share as .swarm…', onClick: () => requestShare({ kind: 'session', id: entry.id, name: entry.label }) } as CardMenuRow,
    ] : []),
    { kind: 'separator' },
    {
      label: 'Close',
      danger: true,
      onClick: () => {
        if (entry.kind === 'browser') { dispatch(recordClosedCard({ kind: 'browser', id: entry.id })); void removeBrowserCardCleanly(entry.id, dispatch); return; }
        if (entry.kind === 'view') { dispatch(recordClosedCard({ kind: 'view', id: entry.id })); void removeViewCardCleanly(entry.id, dispatch); return; }
        if (entry.kind === 'workflow') { dispatch(recordClosedCard({ kind: 'workflow', id: entry.id })); dispatch(removeWorkflowCard(entry.id)); return; }
        dispatch(recordClosedCard({ kind: 'agent', id: entry.id }));
        dispatch(removeCard(entry.id));
        void dispatch(closeSession({ sessionId: entry.id }));
      },
    },
  ];
}
