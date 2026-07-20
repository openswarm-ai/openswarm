import { closeSession } from '@/shared/state/agentsSlice';
import { removeNote, removeWorkflowCard, closeWorkflowsHub, recordClosedCard } from '@/shared/state/dashboardLayoutSlice';
import { closeWorkflowCard } from '@/shared/state/workflowsSlice';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import type { AppDispatch } from '@/shared/state/store';
import type { CardType } from '../state/useDashboardSelection';

/** Close every selected card, recording each so Cmd+Shift+T can bring it back. */
export function deleteSelectedCards(selectedIds: Map<string, CardType>, dispatch: AppDispatch): void {
  const viewIds: string[] = [];
  for (const [id, type] of selectedIds) {
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
}
