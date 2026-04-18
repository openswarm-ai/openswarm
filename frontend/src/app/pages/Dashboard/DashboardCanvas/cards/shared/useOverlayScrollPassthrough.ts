import { useRef, useEffect } from 'react';

/**
 * Attaches a native wheel listener to an overlay element that forwards scroll
 * events to whatever scrollable content sits beneath it, while still letting
 * the overlay capture pointer events (click / drag).  Pinch-zoom (ctrl/meta +
 * wheel) is left alone so the canvas zoom still works.
 *
 * Handles two cases:
 *  1. Regular DOM scrollable containers — uses `scrollBy` directly.
 *  2. Electron `<webview>` elements — executes JS inside the webview to scroll
 *     the element at the cursor position.
 */
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
