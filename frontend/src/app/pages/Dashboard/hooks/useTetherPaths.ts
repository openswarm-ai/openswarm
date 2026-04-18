import { useMemo } from 'react';
import type { RefObject } from 'react';
import { EXPANDED_CARD_MIN_H } from '@/shared/state/dashboardLayoutSlice';
import type { TetherInfo } from '@/app/pages/Dashboard/types/types';

interface TetherDeps {
  glowingAgentCards: Record<string, { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string }>;
  glowingBrowserCards: Record<string, { sourceId: string; fading: boolean; label?: string }>;
  cards: Record<string, any>;
  browserCards: Record<string, any>;
  expandedSessionIds: string[];
  liveDragInfo: { cardId: string; dx: number; dy: number } | null;
  measuredHeightsRef: RefObject<Record<string, number>>;
  measuredHeightsTick: number;
}

const ELBOW_RADIUS = 16;

function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const midX = x1 + dx / 2;
  const r = (Math.abs(dy) < 1 || Math.abs(dx) < ELBOW_RADIUS * 2)
    ? 0
    : Math.min(ELBOW_RADIUS, Math.abs(dy) / 2, Math.abs(dx) / 4);
  const sy = dy >= 0 ? 1 : -1;
  const sx = dx >= 0 ? 1 : -1;
  return [
    `M ${x1},${y1}`,
    `H ${midX - sx * r}`,
    `Q ${midX},${y1} ${midX},${y1 + sy * r}`,
    `V ${y2 - sy * r}`,
    `Q ${midX},${y2} ${midX + sx * r},${y2}`,
    `H ${x2}`,
  ].join(' ');
}

export function useTetherPaths(deps: TetherDeps): TetherInfo[] {
  const {
    glowingAgentCards, glowingBrowserCards, cards, browserCards,
    expandedSessionIds, liveDragInfo, measuredHeightsRef, measuredHeightsTick,
  } = deps;

  return useMemo(() => {
    function cardH(id: string, card: any): number {
      return (measuredHeightsRef.current ?? {})[id]
        ?? (expandedSessionIds.includes(id) ? Math.max(EXPANDED_CARD_MIN_H, card.height) : card.height);
    }
    function applyDrag(x: number, y: number, id: string) {
      if (liveDragInfo && liveDragInfo.cardId === id) {
        return { x: x + liveDragInfo.dx, y: y + liveDragInfo.dy };
      }
      return { x, y };
    }

    const agentTethers = Object.entries(glowingAgentCards).map(([copyId, { sourceId, fading, label }]) => {
      const src = cards[sourceId];
      const dst = cards[copyId];
      if (!src || !dst) return null;
      const s = applyDrag(src.x, src.y, sourceId);
      const d = applyDrag(dst.x, dst.y, copyId);
      const srcH = cardH(sourceId, src);
      const dstH = cardH(copyId, dst);
      const x1 = s.x + src.width, y1 = s.y + srcH * 0.54;
      const x2 = d.x, y2 = d.y + dstH * (expandedSessionIds.includes(copyId) ? 0.54 : 0.79);
      const midX = x1 + (x2 - x1) / 2;
      return {
        key: copyId,
        path: elbowPath(x1, y1, x2, y2),
        labelX: midX + (x2 - midX) * 0.15,
        labelY: y2,
        label: label || '',
        fading,
      };
    }).filter(Boolean) as TetherInfo[];

    const browserTethers = Object.entries(glowingBrowserCards).map(([browserId, { sourceId, fading, label }]) => {
      const src = cards[sourceId];
      const dst = browserCards[browserId];
      if (!src || !dst) return null;
      const s = applyDrag(src.x, src.y, sourceId);
      const d = applyDrag(dst.x, dst.y, browserId);
      const srcH = cardH(sourceId, src);
      const dstH = dst.height;
      const srcCx = s.x + src.width / 2;
      const dstCx = d.x + dst.width / 2;

      type Anchor = { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' };
      const srcAnchors: Anchor[] = [
        { x: s.x + src.width, y: s.y + srcH * 0.54, side: 'right' },
        { x: s.x, y: s.y + srcH * 0.54, side: 'left' },
        { x: srcCx, y: s.y, side: 'top' },
        { x: srcCx, y: s.y + srcH, side: 'bottom' },
      ];
      const dstAnchors: Anchor[] = [
        { x: d.x, y: d.y + dstH * 0.54, side: 'left' },
        { x: d.x + dst.width, y: d.y + dstH * 0.54, side: 'right' },
        { x: dstCx, y: d.y, side: 'top' },
        { x: dstCx, y: d.y + dstH, side: 'bottom' },
      ];

      let bestSrc = srcAnchors[0], bestDst = dstAnchors[0], bestDist = Infinity;
      for (const sa of srcAnchors) {
        for (const da of dstAnchors) {
          const dd = Math.hypot(sa.x - da.x, sa.y - da.y);
          if (dd < bestDist) { bestDist = dd; bestSrc = sa; bestDst = da; }
        }
      }

      const x1 = bestSrc.x, y1 = bestSrc.y, x2 = bestDst.x, y2 = bestDst.y;
      const isVertical = (bestSrc.side === 'top' || bestSrc.side === 'bottom')
        && (bestDst.side === 'top' || bestDst.side === 'bottom');

      let pathD: string;
      if (isVertical) {
        const dx = x2 - x1, dy = y2 - y1;
        const midY = y1 + dy / 2;
        const r = (Math.abs(dx) < 1 || Math.abs(dy) < ELBOW_RADIUS * 2)
          ? 0
          : Math.min(ELBOW_RADIUS, Math.abs(dx) / 2, Math.abs(dy) / 4);
        const sx = dx >= 0 ? 1 : -1;
        const sy = dy >= 0 ? 1 : -1;
        pathD = [
          `M ${x1},${y1}`,
          `V ${midY - sy * r}`,
          `Q ${x1},${midY} ${x1 + sx * r},${midY}`,
          `H ${x2 - sx * r}`,
          `Q ${x2},${midY} ${x2},${midY + sy * r}`,
          `V ${y2}`,
        ].join(' ');
      } else {
        pathD = elbowPath(x1, y1, x2, y2);
      }

      const midX = x1 + (x2 - x1) / 2;
      const midY = y1 + (y2 - y1) / 2;
      return {
        key: `browser-${browserId}`,
        path: pathD,
        labelX: isVertical ? midX : midX + (x2 - midX) * 0.15,
        labelY: isVertical ? midY + (y2 - midY) * 0.15 : y2,
        label: label || '',
        fading,
      };
    }).filter(Boolean) as TetherInfo[];

    return [...agentTethers, ...browserTethers];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowingAgentCards, glowingBrowserCards, cards, browserCards, expandedSessionIds, liveDragInfo, measuredHeightsTick]);
}
