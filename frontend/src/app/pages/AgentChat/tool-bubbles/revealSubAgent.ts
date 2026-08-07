import { expandSession, collapseSession, fetchSession } from '@/shared/state/agentsSlice';
import { placeCard, removeCard, setGlowingAgentCard, clearGlowingAgentCard, DEFAULT_CARD_W, DEFAULT_CARD_H, EXPANDED_CARD_MIN_H, GRID_GAP } from '@/shared/state/dashboardLayoutSlice';
import { store } from '@/shared/state/store';
import type { AppDispatch } from '@/shared/state/store';

// The reveal-sub-agent click, reading the store lazily on purpose: subscribing every tool row to
// whole sessions/cards re-rendered the entire transcript per streamed character (ENG-156).
export function revealSubAgent(
  dispatch: AppDispatch,
  sessionId: string,
  targetSessionId: string,
  bubbleEl: HTMLElement | null,
  label: string,
): void {
  const cards = store.getState().dashboardLayout.cards;

  if (cards[targetSessionId]) {
    dispatch(collapseSession(targetSessionId));
    dispatch(removeCard(targetSessionId));
    setTimeout(() => {
      dispatch(clearGlowingAgentCard(targetSessionId));
    }, 500);
    return;
  }

  let sourceYRatio: number | undefined;
  if (bubbleEl) {
    const cardEl = bubbleEl.closest('[data-select-type="agent-card"]') as HTMLElement | null;
    if (cardEl) {
      const cardRect = cardEl.getBoundingClientRect();
      const bubbleRect = bubbleEl.getBoundingClientRect();
      const bubbleCenterY = bubbleRect.top + bubbleRect.height / 2;
      const ratio = (bubbleCenterY - cardRect.top) / cardRect.height;
      sourceYRatio = Math.max(0, Math.min(1, ratio));
    }
  }

  const doPlace = (): void => {
    const cardsNow = store.getState().dashboardLayout.cards;
    const parentCard = cardsNow[sessionId];
    const targetX = parentCard
      ? parentCard.x + parentCard.width + GRID_GAP * 12
      : 40;
    let targetY = parentCard ? parentCard.y : 100;
    if (parentCard) {
      const columnCards = Object.values(cardsNow).filter(
        (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== targetSessionId,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }
    }
    dispatch(placeCard({
      sessionId: targetSessionId,
      x: targetX,
      y: targetY,
      width: DEFAULT_CARD_W,
      height: DEFAULT_CARD_H,
      expandedSessionIds: store.getState().agents.expandedSessionIds,
    }));
    dispatch(expandSession(targetSessionId));
    dispatch(setGlowingAgentCard({ sessionId: targetSessionId, sourceId: sessionId, sourceYRatio, label }));
  };

  if (!store.getState().agents.sessions[targetSessionId]) {
    void dispatch(fetchSession(targetSessionId)).then(doPlace);
  } else {
    doPlace();
  }
}
