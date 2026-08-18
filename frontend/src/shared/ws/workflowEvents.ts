import { store } from '../state/store';
import { openWorkflowMonitor } from '../state/dashboardLayoutSlice';
import { upsertRun, upsertWorkflow, removeWorkflow } from '../state/workflowsSlice';
import { notifyWorkflowRun } from '../notifications';
import type { WSEvent } from './types';
import type { WsEventHandlerResult } from './eventHandlerTypes';

// Manual runs whose monitor card we've already popped open, so repeated workflow:run updates don't re-pin the monitor.
const autoOpenedRunIds = new Set<string>();

export function handleWorkflowEvent(msg: WSEvent): WsEventHandlerResult {
  const { event, data } = msg;

  switch (event) {
    case 'workflow:run':
      if (data.run) {
        const run = data.run;
        store.dispatch(upsertRun(run));
        if (run.status === 'running' && run.triggered_by === 'manual' && run.id && !autoOpenedRunIds.has(run.id)) {
          autoOpenedRunIds.add(run.id);
          store.dispatch(openWorkflowMonitor({ workflowId: run.workflow_id, runId: run.id }));
        }
      }
      return true;

    case 'workflow:updated':
      if (data.workflow) {
        store.dispatch(upsertWorkflow(data.workflow));
      }
      return true;

    case 'workflow:deleted':
      if (data.workflow_id) {
        store.dispatch(removeWorkflow(data.workflow_id));
      }
      return true;

    case 'workflow:notify':
      if (data.workflow_id) {
        notifyWorkflowRun({
          workflowId: data.workflow_id,
          workflowTitle: data.workflow_title || 'Workflow',
          runId: data.run_id,
          sessionId: data.session_id,
          status: data.status,
          tierKind: data.tier_kind,
          fallback: data.fallback,
        });
      }
      return true;
    default:
      return null;
  }
}
