// Per-frame drag deltas travel OUTSIDE React: a drag move fires at pointer rate (120Hz on ProMotion),
// and holding this in page-level state re-rendered the whole dashboard per frame (the ENG-88 input
// delay). Publishers write here; the one consumer that must follow live (the tether layer) subscribes
// and re-renders alone.

import type { LiveDragInfo } from '../../geometry/dashboardTethers';

type Listener = (info: LiveDragInfo | null) => void;

const listeners = new Set<Listener>();

export function publishLiveDrag(info: LiveDragInfo | null): void {
  for (const listener of listeners) listener(info);
}

export function subscribeLiveDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
