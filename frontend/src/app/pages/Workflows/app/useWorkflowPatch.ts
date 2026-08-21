import { useCallback } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import { applyOptimisticPatch, updateWorkflow, refreshWorkflow } from '@/shared/state/workflowsSlice';
import type { Workflow } from '@/shared/state/workflowsSlice';

/** A patch can be built from the freshest copy of the workflow, so a toggle never carries a sibling field that another write changed a moment earlier. */
export type WorkflowPatch = Partial<Workflow> | ((current: Workflow) => Partial<Workflow>);

// Writes to one workflow run one at a time: the PATCH carries If-Match on updated_at, and two writes inside a single round-trip used to share a stale If-Match, so the second (the Off switch, typically) 409'd and was thrown away while the optimistic UI kept saying Off. The one that ran on the next launch was the one on disk.
const chains = new Map<string, Promise<void>>();
let opSeq = 0;

function resolvePatch(id: string, patch: WorkflowPatch): Partial<Workflow> | null {
  const current = store.getState().workflows.items[id];
  if (!current) return null;
  return typeof patch === 'function' ? patch(current) : patch;
}

export function useWorkflowPatch() {
  const dispatch = useAppDispatch();
  return useCallback((wf: Workflow, patch: WorkflowPatch) => {
    const first = resolvePatch(wf.id, patch);
    if (!first) return;
    const opId = `${wf.id}:${++opSeq}`;
    dispatch(applyOptimisticPatch({ opId, id: wf.id, patch: first }));
    const run = async (): Promise<void> => {
      const current = store.getState().workflows.items[wf.id];
      const body = resolvePatch(wf.id, patch);
      if (!current || !body) return;
      try {
        await dispatch(updateWorkflow({ id: wf.id, patch: body, ifMatch: current.updated_at, opId })).unwrap();
      } catch (err) {
        // The slice already rolled the item back and raised the notice; a stale write additionally resyncs this one workflow so the next edit starts from truth.
        if ((err as { kind?: string } | undefined)?.kind === 'stale') await dispatch(refreshWorkflow(wf.id));
      }
    };
    const prev = chains.get(wf.id) ?? Promise.resolve();
    const next = prev.then(run, run);
    chains.set(wf.id, next);
    void next.finally(() => { if (chains.get(wf.id) === next) chains.delete(wf.id); });
  }, [dispatch]);
}
