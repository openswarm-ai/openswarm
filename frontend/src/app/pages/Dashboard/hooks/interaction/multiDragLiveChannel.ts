// Co-selected cards follow a drag OUTSIDE React, same shape as marqueeLiveChannel: per-frame
// deltas at pointer rate re-rendered every selected card's whole subtree (the last ENG-88 hole).

export interface MultiDragUpdate {
  ids: ReadonlyArray<string>;
  dx: number;
  dy: number;
}

type Listener = (update: MultiDragUpdate | null) => void;

const listeners = new Set<Listener>();

export function publishMultiDrag(update: MultiDragUpdate | null): void {
  for (const listener of listeners) listener(update);
}

export function subscribeMultiDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
