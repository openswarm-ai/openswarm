import { useState, useCallback, useMemo, useRef, useEffect, RefObject } from 'react';
import type { CardPosition, ViewCardPosition, BrowserCardPosition, WorkflowCardPosition, WorkflowsHubPosition } from '@/shared/state/dashboardLayoutSlice';
import { viewCardKey } from '@/shared/state/dashboardLayoutSlice';
import { publishMarqueeRect } from '../interaction/marqueeLiveChannel';

export type { CardType } from '@/shared/state/dashboardLayoutSlice';
import type { CardType } from '@/shared/state/dashboardLayoutSlice';

export interface SelectedCard {
  id: string;
  type: CardType;
}

export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenToCanvas {
  // The LIVE camera getter, never committed React state: a marquee drawn during a pan glide or
  // inertia was converted with the stale pre-gesture camera and landed far from the mouse.
  getLiveState: () => { panX: number; panY: number; zoom: number };
  viewportRef: RefObject<HTMLDivElement | null>;
}

const DRAG_THRESHOLD = 4;


function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function useDashboardSelection(
  canvas: ScreenToCanvas,
  cards: Record<string, CardPosition>,
  viewCards: Record<string, ViewCardPosition>,
  browserCards: Record<string, BrowserCardPosition> = {},
  workflowCards: Record<string, WorkflowCardPosition> = {},
  workflowsHub: WorkflowsHubPosition | null = null,
) {
  const [selectedIds, setSelectedIds] = useState<Map<string, CardType>>(new Map());
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);

  const marqueeOriginRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const isDraggingMarqueeRef = useRef(false);
  const shiftHeldRef = useRef(false);
  const selectionBeforeMarqueeRef = useRef<Map<string, CardType>>(new Map());
  // Cached at marquee arm: a live getBoundingClientRect per move forces layout mid-drag, and the
  // viewport element itself never moves during a marquee (only its content transform does).
  const marqueeVpRectRef = useRef<DOMRect | null>(null);
  const marqueeRafRef = useRef<number | null>(null);
  const latestMoveRef = useRef<{ x: number; y: number } | null>(null);

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number) => {
      const vp = canvas.viewportRef.current;
      if (!vp) return { x: 0, y: 0 };
      const rect = marqueeVpRectRef.current ?? vp.getBoundingClientRect();
      const cam = canvas.getLiveState();
      return {
        x: (screenX - rect.left - cam.panX) / cam.zoom,
        y: (screenY - rect.top - cam.panY) / cam.zoom,
      };
    },
    // The stable members, not the wrapper: the call site builds the wrapper object fresh per render.
    [canvas.getLiveState, canvas.viewportRef],
  );

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const deselectAll = useCallback(() => setSelectedIds(new Map()), []);

  // Cmd/Ctrl+A: select every card on the canvas so the user can wipe the board in one keystroke. Mirrors the per-type id keys the marquee uses.
  const selectAll = useCallback(() => {
    const next = new Map<string, CardType>();
    for (const card of Object.values(cards)) next.set(card.session_id, 'agent');
    for (const vc of Object.values(viewCards)) next.set(viewCardKey(vc.output_id, vc.instance), 'view');
    for (const bc of Object.values(browserCards)) next.set(bc.browser_id, 'browser');
    for (const wc of Object.values(workflowCards)) next.set(wc.workflow_id, 'workflow');
    if (workflowsHub) next.set('workflows-hub', 'workflows-hub');
    setSelectedIds(next);
  }, [cards, viewCards, browserCards, workflowCards, workflowsHub]);

  const selectCard = useCallback(
    (id: string, type: CardType, shiftKey: boolean) => {
      setSelectedIds((prev) => {
        if (shiftKey) {
          const next = new Map(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.set(id, type);
          }
          return next;
        }
        // Plain click/press selects the clicked card so spawn-beside-selection actually fires; deselect = empty-canvas click or Esc. An already-selected member keeps the whole selection (a press also starts multi-drag; collapsing would break it) but moves to last so the clicked card is the spawn anchor.
        if (prev.has(id)) {
          if (Array.from(prev.keys()).pop() === id) return prev;
          const next = new Map(prev);
          next.delete(id);
          next.set(id, type);
          return next;
        }
        return new Map([[id, type]]);
      });
    },
    [],
  );

  const selectedArray = useCallback((): SelectedCard[] => {
    return Array.from(selectedIds.entries()).map(([id, type]) => ({ id, type }));
  }, [selectedIds]);

  const computeMarqueeSelection = useCallback(
    (rect: MarqueeRect, shiftKey: boolean) => {
      const intersecting = new Map<string, CardType>();

      for (const card of Object.values(cards)) {
        if (
          rectsIntersect(rect, {
            x: card.x,
            y: card.y,
            width: card.width,
            height: card.height,
          })
        ) {
          intersecting.set(card.session_id, 'agent');
        }
      }

      for (const vc of Object.values(viewCards)) {
        if (
          rectsIntersect(rect, {
            x: vc.x,
            y: vc.y,
            width: vc.width,
            height: vc.height,
          })
        ) {
          intersecting.set(viewCardKey(vc.output_id, vc.instance), 'view');
        }
      }

      for (const bc of Object.values(browserCards)) {
        if (
          rectsIntersect(rect, {
            x: bc.x,
            y: bc.y,
            width: bc.width,
            height: bc.height,
          })
        ) {
          intersecting.set(bc.browser_id, 'browser');
        }
      }

      for (const wc of Object.values(workflowCards)) {
        if (
          rectsIntersect(rect, {
            x: wc.x,
            y: wc.y,
            width: wc.width,
            height: wc.height,
          })
        ) {
          intersecting.set(wc.workflow_id, 'workflow');
        }
      }

      if (
        workflowsHub &&
        rectsIntersect(rect, {
          x: workflowsHub.x,
          y: workflowsHub.y,
          width: workflowsHub.width,
          height: workflowsHub.height,
        })
      ) {
        intersecting.set('workflows-hub', 'workflows-hub');
      }

      if (shiftKey) {
        const base = selectionBeforeMarqueeRef.current;
        const next = new Map(base);
        for (const [id, type] of intersecting) {
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.set(id, type);
          }
        }
        return next;
      }

      return intersecting;
    },
    [cards, viewCards, browserCards, workflowCards, workflowsHub],
  );

  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      // A press starting on a card is a card interaction (select/drag), not a marquee; arming here would make the mouseup deselect the card that was just clicked.
      if ((e.target as HTMLElement)?.closest?.('[data-select-id]')) return;

      marqueeOriginRef.current = { screenX: e.clientX, screenY: e.clientY };
      isDraggingMarqueeRef.current = false;
      shiftHeldRef.current = e.shiftKey;
      selectionBeforeMarqueeRef.current = new Map(selectedIds);
      marqueeVpRectRef.current = canvas.viewportRef.current?.getBoundingClientRect() ?? null;
    },
    [selectedIds, canvas.viewportRef],
  );

  const handleCanvasMouseMove = useCallback(
    (e: MouseEvent) => {
      const origin = marqueeOriginRef.current;
      if (!origin) return;

      const dx = e.clientX - origin.screenX;
      const dy = e.clientY - origin.screenY;

      if (!isDraggingMarqueeRef.current) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        isDraggingMarqueeRef.current = true;
        document.body.style.userSelect = 'none';
        // Disable pointer events on webviews/iframes during drag so the cursor passes through.
        document.body.classList.add('dashboard-marquee-active');
      }

      // One update per frame, not per pointermove: 120Hz mice fired two renders per painted frame.
      latestMoveRef.current = { x: e.clientX, y: e.clientY };
      if (marqueeRafRef.current !== null) return;
      marqueeRafRef.current = requestAnimationFrame(() => {
        marqueeRafRef.current = null;
        const o = marqueeOriginRef.current;
        const p = latestMoveRef.current;
        if (!o || !p || !isDraggingMarqueeRef.current) return;
        const start = screenToCanvas(o.screenX, o.screenY);
        const end = screenToCanvas(p.x, p.y);
        const rect: MarqueeRect = {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        };
        // React mounts the rect once; per-frame movement rides the channel (the layer re-rendered per frame otherwise).
        publishMarqueeRect(rect);
        setMarquee((prev) => prev ?? rect);
        const next = computeMarqueeSelection(rect, shiftHeldRef.current);
        // Same membership = same state object, so sweeping across empty space re-renders nothing.
        setSelectedIds((prev) => {
          if (prev.size === next.size) {
            let same = true;
            for (const [id, type] of next) {
              if (prev.get(id) !== type) { same = false; break; }
            }
            if (same) return prev;
          }
          return next;
        });
      });
    },
    [screenToCanvas, computeMarqueeSelection],
  );

  // Returns true when the release ended a real marquee DRAG, so the caller can tell a rubber-band
  // gesture from a plain click without duplicating the threshold bookkeeping.
  const handleCanvasMouseUp = useCallback(
    (e: MouseEvent): boolean => {
      const origin = marqueeOriginRef.current;
      if (!origin) return false;

      const dragged = isDraggingMarqueeRef.current;
      if (!dragged && !e.shiftKey) deselectAll();

      marqueeOriginRef.current = null;
      isDraggingMarqueeRef.current = false;
      marqueeVpRectRef.current = null;
      if (marqueeRafRef.current !== null) {
        cancelAnimationFrame(marqueeRafRef.current);
        marqueeRafRef.current = null;
      }
      publishMarqueeRect(null);
      setMarquee(null);
      document.body.style.userSelect = '';
      document.body.classList.remove('dashboard-marquee-active');
      return dragged;
    },
    [deselectAll],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        deselectAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deselectAll]);

  // Inject (once) a global CSS rule that makes browser webviews and iframes transparent to mouse events while a marquee drag is active. Without this, the Electron <webview> hit-tests the cursor at the OS level, when the cursor lands on an interactable element inside the browser (button, link, text), the webview steals the cursor and the marquee drag visually freezes until the cursor escapes. Setting `pointer-events: none` makes the cursor pass straight through, so the dashboard's mousemove handler continues to fire and the marquee keeps growing smoothly.
  useEffect(() => {
    const id = 'dashboard-marquee-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      body.dashboard-marquee-active webview,
      body.dashboard-marquee-active iframe {
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);
  }, []);

  // Stable identity: consumers (the memoized card layer, the drag hook) receive this whole object as a prop, and a fresh literal per render re-rendered them all on every controller commit, including each frame of a card drag.
  return useMemo(() => ({
    selectedIds,
    selectedArray,
    marquee,
    isSelected,
    selectCard,
    deselectAll,
    selectAll,
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasMouseUp,
  }), [selectedIds, selectedArray, marquee, isSelected, selectCard, deselectAll, selectAll, handleCanvasMouseDown, handleCanvasMouseMove, handleCanvasMouseUp]);
}
