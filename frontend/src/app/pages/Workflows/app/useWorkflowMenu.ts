import { useCallback } from 'react';
import type React from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { deleteWorkflow, runWorkflowNow } from '@/shared/state/workflowsSlice';
import type { Workflow } from '@/shared/state/workflowsSlice';
import { openWorkflowMonitor } from '@/shared/state/dashboardLayoutSlice';
import { stepsSignature } from '@/app/pages/Workflows/scheduleUtils';
import { openCardContextMenu, isNativeMenuTarget } from '@/app/pages/Dashboard/desktop/openCardContextMenu';
import { isRunning } from './model';
import { useWorkflowPatch } from './useWorkflowPatch';

interface WorkflowMenuOptions {
  onEdit: () => void;
  afterTrash?: () => void;
}

/** The one workflow right-click row set, so every surface (rail, home, calendars, popover) offers the same verbs. */
export function useWorkflowMenu(): (e: React.MouseEvent, wf: Workflow, opts: WorkflowMenuOptions) => void {
  const dispatch = useAppDispatch();
  const active = useAppSelector((s) => s.workflows.active);
  const patch = useWorkflowPatch();
  return useCallback((e: React.MouseEvent, wf: Workflow, opts: WorkflowMenuOptions) => {
    if (isNativeMenuTarget(e)) return;
    const running = isRunning(wf, active);
    openCardContextMenu(e, {
      items: [
        {
          label: 'Run now',
          disabled: running,
          onClick: () => {
            dispatch(runWorkflowNow({ id: wf.id, signature: stepsSignature(wf.steps) }));
            dispatch(openWorkflowMonitor({ workflowId: wf.id }));
          },
        },
        {
          label: wf.schedule.enabled ? 'Pause schedule' : 'Resume schedule',
          onClick: () => patch(wf, { schedule: { ...wf.schedule, enabled: !wf.schedule.enabled } }),
        },
        { label: 'Edit', onClick: opts.onEdit },
        { kind: 'separator' },
        {
          label: 'Move to Trash',
          danger: true,
          onClick: () => {
            dispatch(deleteWorkflow(wf.id));
            opts.afterTrash?.();
          },
        },
      ],
    });
  }, [dispatch, active, patch]);
}
