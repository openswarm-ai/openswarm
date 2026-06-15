import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { report } from '@/shared/serviceClient';
import { useAppDispatch } from '@/shared/hooks';
import { expandSession } from '@/shared/state/agentsSlice';
import { bringToFront } from '@/shared/state/dashboardLayoutSlice';
import type { CardPosition, ViewCardPosition, BrowserCardPosition, WorkflowCardPosition } from '@/shared/state/dashboardLayoutSlice';
import type { CardType } from '../state/useDashboardSelection';
import type { CanvasActions } from './useCanvasControls';

type Direction = 'left' | 'right' | 'up' | 'down';

interface UseArrowNavArgs {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  zoom: number;
  isActive: boolean;
  focusedCardId: string | null;
  setFocusedCardId: Dispatch<SetStateAction<string | null>>;
  canvasActions: CanvasActions;
  getCardRect: (id: string, type: CardType) => { x: number; y: number; width: number; height: number } | undefined;
}

export function useArrowNav({
  cards,
  viewCards,
  browserCards,
  workflowCards,
  zoom,
  isActive,
  focusedCardId,
  setFocusedCardId,
  canvasActions,
  getCardRect,
}: UseArrowNavArgs) {
  const dispatch = useAppDispatch();

  const findNearestCard = useCallback((
    currentId: string,
    direction: Direction,
  ): { id: string; type: CardType } | null => {
    const allCardEntries: Array<{ id: string; type: CardType; cx: number; cy: number }> = [];
    for (const card of Object.values(cards)) {
      allCardEntries.push({ id: card.session_id, type: 'agent', cx: card.x + card.width / 2, cy: card.y + card.height / 2 });
    }
    for (const vc of Object.values(viewCards)) {
      allCardEntries.push({ id: vc.output_id, type: 'view', cx: vc.x + vc.width / 2, cy: vc.y + vc.height / 2 });
    }
    for (const bc of Object.values(browserCards)) {
      allCardEntries.push({ id: bc.browser_id, type: 'browser', cx: bc.x + bc.width / 2, cy: bc.y + bc.height / 2 });
    }
    for (const wc of Object.values(workflowCards)) {
      allCardEntries.push({ id: wc.workflow_id, type: 'workflow', cx: wc.x + wc.width / 2, cy: wc.y + wc.height / 2 });
    }

    const current = allCardEntries.find((c) => c.id === currentId);
    if (!current) return null;

    let best: typeof allCardEntries[0] | null = null;
    let bestScore = Infinity;

    for (const card of allCardEntries) {
      if (card.id === currentId) continue;
      const dx = card.cx - current.cx;
      const dy = card.cy - current.cy;

      // Filter to the correct half-plane
      let inDirection = false;
      let primary = 0;
      let secondary = 0;
      switch (direction) {
        case 'right': inDirection = dx > 20; primary = dx; secondary = Math.abs(dy); break;
        case 'left':  inDirection = dx < -20; primary = -dx; secondary = Math.abs(dy); break;
        case 'down':  inDirection = dy > 20; primary = dy; secondary = Math.abs(dx); break;
        case 'up':    inDirection = dy < -20; primary = -dy; secondary = Math.abs(dx); break;
      }
      if (!inDirection) continue;

      const score = primary + secondary * 0.3;
      if (score < bestScore) {
        bestScore = score;
        best = card;
      }
    }

    return best ? { id: best.id, type: best.type } : null;
  }, [cards, viewCards, browserCards, workflowCards]);

  // Compute which directions have neighbors from the focused card
  const neighborDirections = useMemo(() => {
    // Lowered the zoom floor from 0.9 to 0.4 so arrow nav still works
    // when users zoom out to see the whole canvas. Below 0.4 the cards
    // are too small to be a useful navigation target.
    if (!focusedCardId || zoom < 0.4) return { left: false, right: false, up: false, down: false };
    return {
      left: !!findNearestCard(focusedCardId, 'left'),
      right: !!findNearestCard(focusedCardId, 'right'),
      up: !!findNearestCard(focusedCardId, 'up'),
      down: !!findNearestCard(focusedCardId, 'down'),
    };
  }, [focusedCardId, zoom, findNearestCard]);

  // Shake animation state: direction + timer
  const [shakeDirection, setShakeDirection] = useState<Direction | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs for values read inside the keydown handler to avoid stale closures
  const focusedCardIdRef = useRef(focusedCardId);
  focusedCardIdRef.current = focusedCardId;
  const canvasZoomRef = useRef(zoom);
  canvasZoomRef.current = zoom;

  useEffect(() => {
    // Helper: is the currently-focused element a text-entry field the
    // user is actively editing? We only want to suppress dashboard
    // navigation when the user is genuinely typing, not just because an
    // input somewhere happens to have focus from a click long ago.
    const isActivelyEditing = (target: EventTarget | null): boolean => {
      const el = (target as HTMLElement) || (document.activeElement as HTMLElement | null);
      if (!el) return false;
      const tag = el.tagName;
      const editable = (el as any).isContentEditable;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !editable) return false;
      // Only suppress when the input actually has content to navigate
      // within. An empty input doesn't need arrow keys for cursor
      // movement, so we can safely repurpose arrows for dashboard nav.
      const val = (el as HTMLInputElement | HTMLTextAreaElement).value;
      if (typeof val === 'string' && val.length === 0) return false;
      if (editable && (el.textContent ?? '').length === 0) return false;
      return true;
    };

    const handleKey = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden

      // Escape blurs any active input and restores focus to the canvas ,
      // so you can quickly "unstick" keyboard focus and start navigating.
      if (e.key === 'Escape') {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (active as any)?.isContentEditable) {
          active?.blur?.();
        }
        return;
      }

      let direction: Direction | null = null;
      switch (e.key) {
        case 'ArrowLeft': direction = 'left'; break;
        case 'ArrowRight': direction = 'right'; break;
        case 'ArrowUp': direction = 'up'; break;
        case 'ArrowDown': direction = 'down'; break;
        default: return;
      }

      // Don't hijack arrows when the user is actually typing
      if (isActivelyEditing(e.target)) return;

      // Lowered zoom floor from 0.9 → 0.4 so nav still works zoomed out
      if (canvasZoomRef.current < 0.4) return;

      // If no card is focused, pick the front-most one as a fallback so
      // nav works after the user clicked on empty canvas.
      let currentFocused = focusedCardIdRef.current;
      if (!currentFocused) {
        const anyCardId = Object.keys(cards)[0] || Object.keys(viewCards)[0] || Object.keys(browserCards)[0];
        if (!anyCardId) return;
        currentFocused = anyCardId;
        setFocusedCardId(anyCardId);
      }

      e.preventDefault();
      const target = findNearestCard(currentFocused, direction);

      if (!target) {
        // No card in that direction , shake
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
        setShakeDirection(direction);
        shakeTimerRef.current = setTimeout(() => {
          setShakeDirection(null);
          shakeTimerRef.current = null;
        }, 400);
        return;
      }

      // Expand + navigate to target + bring to front
      report('dashboard', 'arrow_navigated', { direction, from_card: currentFocused, to_card: target.id });
      if (target.type === 'agent') {
        dispatch(expandSession(target.id));
      }
      dispatch(bringToFront({ id: target.id, type: target.type }));
      setFocusedCardId(target.id);

      setTimeout(() => {
        const rect = getCardRect(target.id, target.type);
        if (rect) canvasActions.fitToCards([rect], 1.15, true);
        setTimeout(() => (document.activeElement as HTMLElement)?.blur?.(), 150);
      }, 100);
    };

    // Capture phase so we beat MUI Menus/Selects that also listen for
    // arrows. We still bail early on isActivelyEditing, so this doesn't
    // interfere with typing.
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [findNearestCard, getCardRect, canvasActions, dispatch, isActive, cards, viewCards, browserCards, setFocusedCardId]);

  return { neighborDirections, shakeDirection };
}
