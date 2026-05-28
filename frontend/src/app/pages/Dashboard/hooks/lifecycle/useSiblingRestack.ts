import { useEffect, type RefObject } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  moveCards,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  type CardPosition,
  type BrowserCardPosition,
} from '@/shared/state/dashboardLayoutSlice';

interface GlowingCard {
  sourceId: string;
}

interface UseSiblingRestackArgs {
  isActive: boolean;
  expandedSessionIds: string[];
  glowingAgentCards: Record<string, GlowingCard>;
  glowingBrowserCards: Record<string, GlowingCard>;
  cards: Record<string, CardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  measuredHeightsRef: RefObject<Record<string, number>>;
  measuredHeightsTick: number;
}

export function useSiblingRestack({
  isActive,
  expandedSessionIds,
  glowingAgentCards,
  glowingBrowserCards,
  cards,
  browserCards,
  measuredHeightsRef,
  measuredHeightsTick,
}: UseSiblingRestackArgs) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!isActive) return;  // Heavy geometry recalculation , pause when dashboard is hidden
    const DRIFT_THRESHOLD = 60;

    // Group tethered sub-agent cards by source, only including those still in the spawn column
    const sourceToSiblings = new Map<string, string[]>();
    for (const [id, glow] of Object.entries(glowingAgentCards)) {
      const card = cards[id];
      if (!card) continue;
      const sourceCard = cards[glow.sourceId];
      if (!sourceCard) continue;
      const expectedX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      if (Math.abs(card.x - expectedX) > DRIFT_THRESHOLD) continue;
      const list = sourceToSiblings.get(glow.sourceId) ?? [];
      list.push(id);
      sourceToSiblings.set(glow.sourceId, list);
    }

    for (const siblings of sourceToSiblings.values()) {
      if (siblings.length < 2) continue;
      siblings.sort((a, b) => cards[a].y - cards[b].y);

      let cursor = cards[siblings[0]].y;
      for (const id of siblings) {
        const card = cards[id];
        const dy = cursor - card.y;
        if (Math.abs(dy) > 1) {
          dispatch(moveCards({ items: [{ id, type: 'agent' as const }], dx: 0, dy }));
        }
        const isExpanded = expandedSessionIds.includes(id);
        const h = isExpanded
          ? Math.max(EXPANDED_CARD_MIN_H, card.height)
          : (measuredHeightsRef.current![id] ?? card.height);
        cursor += h + GRID_GAP * 2;
      }
    }
  // measuredHeightsTick in deps ensures we re-run once ResizeObserver reports
  // the new height after a collapse (avoids stale-height no-ops)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, expandedSessionIds, glowingAgentCards, cards, dispatch, measuredHeightsTick]);

  useEffect(() => {
    if (!isActive) return;  // Heavy geometry recalculation , pause when dashboard is hidden
    const DRIFT_THRESHOLD = 60;

    const sourceToSiblings = new Map<string, string[]>();
    for (const [browserId, glow] of Object.entries(glowingBrowserCards)) {
      const bc = browserCards[browserId];
      if (!bc) continue;
      const sourceCard = cards[glow.sourceId];
      if (!sourceCard) continue;
      const expectedX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      if (Math.abs(bc.x - expectedX) > DRIFT_THRESHOLD) continue;
      const list = sourceToSiblings.get(glow.sourceId) ?? [];
      list.push(browserId);
      sourceToSiblings.set(glow.sourceId, list);
    }

    for (const siblings of sourceToSiblings.values()) {
      if (siblings.length < 2) continue;
      siblings.sort((a, b) => browserCards[a].y - browserCards[b].y);

      let cursor = browserCards[siblings[0]].y;
      for (const id of siblings) {
        const bc = browserCards[id];
        const dy = cursor - bc.y;
        if (Math.abs(dy) > 1) {
          dispatch(moveCards({ items: [{ id, type: 'browser' as const }], dx: 0, dy }));
        }
        cursor += bc.height + GRID_GAP * 2;
      }
    }
  }, [isActive, glowingBrowserCards, browserCards, cards, dispatch]);
}
