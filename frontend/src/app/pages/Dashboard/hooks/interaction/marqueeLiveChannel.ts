// Per-frame marquee rects travel OUTSIDE React, same pattern as liveDragChannel: a sweep at pointer
// rate re-rendered the whole card layer per frame just to move one rectangle (measured 61% dropped
// frames). React mounts/unmounts the rect; this channel moves it.

export interface LiveMarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Listener = (rect: LiveMarqueeRect | null) => void;

const listeners = new Set<Listener>();

export function publishMarqueeRect(rect: LiveMarqueeRect | null): void {
  for (const listener of listeners) listener(rect);
}

export function subscribeMarqueeRect(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
