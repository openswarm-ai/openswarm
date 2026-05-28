// Module-level ref (not React state) so ResizeObservers can bail O(1) without subscription overhead.
let _isPanning = false;

const listeners: Set<() => void> = new Set();

export function isCanvasInteractionActive(): boolean {
  return _isPanning;
}

export function setCanvasInteractionActive(active: boolean) {
  if (_isPanning === active) return;
  const wasActive = _isPanning;
  _isPanning = active;
  // End-of-interaction: flush work suppressed during the gesture (re-measure, dispatch, etc.).
  if (wasActive && !active) {
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.warn('[canvas-interaction] listener threw', e); }
    }
  }
}

export function onCanvasInteractionEnd(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
