import { useEffect } from 'react';
import { subscribeMultiDrag } from './multiDragLiveChannel';

// The one consumer of multiDragLiveChannel: style-writes `translate` on co-selected card roots
// per frame. CSS `translate` composes with `transform`, so framer-motion's scale/spring inline
// transforms are never clobbered (the transform-trap that bit the minimized-cards work).
export function useLiveMultiDrag(): void {
  useEffect(() => {
    const els = new Map<string, HTMLElement | null>();
    return subscribeMultiDrag((update) => {
      if (!update) {
        for (const el of els.values()) { if (el) el.style.translate = ''; }
        els.clear();
        return;
      }
      const value = `${update.dx}px ${update.dy}px`;
      for (const id of update.ids) {
        let el = els.get(id);
        if (el === undefined) {
          el = document.querySelector<HTMLElement>(`[data-select-id="${CSS.escape(id)}"]`);
          els.set(id, el);
        }
        if (el) el.style.translate = value;
      }
    });
  }, []);
}
