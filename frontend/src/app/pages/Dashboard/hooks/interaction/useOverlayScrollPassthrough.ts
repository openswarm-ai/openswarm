import { useRef, useEffect } from 'react';

/** Forwards wheel events through an overlay to the content beneath while keeping overlay click/drag; passes pinch-zoom. */
export function useOverlayScrollPassthrough(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;

      el.style.pointerEvents = 'none';
      const underneath = document.elementFromPoint(e.clientX, e.clientY);
      el.style.pointerEvents = '';

      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 20;
        dy *= 20;
      }

      const horizontalDominant = Math.abs(dx) > Math.abs(dy);

      let node = underneath as HTMLElement | null;
      while (node) {
        if (node.tagName === 'WEBVIEW') {
          e.stopPropagation();
          e.preventDefault();
          const rect = node.getBoundingClientRect();
          const relX = Math.round(e.clientX - rect.left);
          const relY = Math.round(e.clientY - rect.top);
          (node as any).executeJavaScript?.(
            `(function(){` +
            `var el=document.elementFromPoint(${relX},${relY});` +
            `while(el){` +
            `var s=getComputedStyle(el);` +
            `if((s.overflowY==='auto'||s.overflowY==='scroll')&&el.scrollHeight>el.clientHeight){el.scrollBy(${dx},${dy});return}` +
            `if((s.overflowX==='auto'||s.overflowX==='scroll')&&el.scrollWidth>el.clientWidth){el.scrollBy(${dx},${dy});return}` +
            `el=el.parentElement}` +
            `window.scrollBy(${dx},${dy})` +
            `})()`
          ).catch(() => {});
          return;
        }

        const cs = getComputedStyle(node);
        const canScrollY =
          node.scrollHeight > node.clientHeight &&
          (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
        const canScrollX =
          node.scrollWidth > node.clientWidth &&
          (cs.overflowX === 'auto' || cs.overflowX === 'scroll');

        // Horizontal-dominant gesture over a vertically-only scrollable
        // container: don't absorb it (scrollBy with dx would be a no-op).
        // Let it bubble to the canvas wheel handler so the canvas pans.
        if (horizontalDominant && !canScrollX) {
          node = node.parentElement;
          continue;
        }

        if (canScrollY || canScrollX) {
          e.stopPropagation();
          e.preventDefault();
          node.scrollBy(dx, dy);
          return;
        }
        node = node.parentElement;
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [active]);

  return ref;
}
