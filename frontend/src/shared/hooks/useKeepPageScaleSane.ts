import { useEffect } from 'react';

// A trackpad pinch that lands anywhere except the canvas magnifies the entire renderer. The canvas
// owns zoom itself and preventDefaults its own pinches, so any page-scale change is unwanted: it
// pushes the sidebar, chats and even the zoom control off-screen, the zoom pill still reads its
// unchanged camera value, and nothing in the UI can undo it (ENG-245). Snap it back.
export function useKeepPageScaleSane(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const api = (window as any).openswarm as OpenSwarmAPI | undefined;
    if (!vv || !api?.resetVisualZoom) return undefined;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = (): void => {
      if (timer) clearTimeout(timer);
      // Settle first: fighting mid-gesture would stutter, and a pinch that ends back at 1 is fine.
      timer = setTimeout(() => {
        if ((window.visualViewport?.scale ?? 1) > 1.01) void api.resetVisualZoom?.();
      }, 400);
    };

    vv.addEventListener('resize', check);
    return () => {
      if (timer) clearTimeout(timer);
      vv.removeEventListener('resize', check);
    };
  }, []);
}
