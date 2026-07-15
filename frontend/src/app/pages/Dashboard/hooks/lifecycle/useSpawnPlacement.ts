import { useCallback, type RefObject } from 'react';
import { store } from '@/shared/state/store';
import { computeSpawnPosition } from '@/shared/state/dashboardLayoutSlice';
import { getCardRect } from '../../geometry/getCardRect';
import type { useDashboardSelection } from '../state/useDashboardSelection';

type Selection = ReturnType<typeof useDashboardSelection>;

interface Args {
  selection: Selection;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasStateRef: RefObject<{ panX: number; panY: number; zoom: number }>;
  expandedSessionIds: string[];
}

// Resolves where a freshly created card (chat/app/browser/note) should land: docked beside the selected card if one is selected, otherwise centered in the current viewport ("in front of you"). Both paths collision-dodge inside computeSpawnPosition. Returns a getter that reads selection + the live store at call time, so the answer reflects whatever is selected the moment the user hits create.
export function useSpawnPlacement({ selection, viewportRef, canvasStateRef, expandedSessionIds }: Args) {
  return useCallback(
    (width: number, height: number): { x: number; y: number } => {
      const layout = store.getState().dashboardLayout;
      // Most-recently selected card wins as the dock anchor (Map preserves insertion order).
      const selected = Array.from(selection.selectedIds.entries());
      if (selected.length > 0) {
        const [id, type] = selected[selected.length - 1];
        const rect = getCardRect(id, type);
        if (rect) return computeSpawnPosition(layout, width, height, { beside: rect }, expandedSessionIds);
      }
      const vp = viewportRef.current;
      const cs = canvasStateRef.current;
      if (vp && cs) {
        const vr = vp.getBoundingClientRect();
        const cx = (vr.width / 2 - cs.panX) / cs.zoom;
        const cy = (vr.height / 2 - cs.panY) / cs.zoom;
        return computeSpawnPosition(layout, width, height, { viewportCenter: { x: cx, y: cy } }, expandedSessionIds);
      }
      return computeSpawnPosition(layout, width, height, {}, expandedSessionIds);
    },
    [selection, viewportRef, canvasStateRef, expandedSessionIds],
  );
}
