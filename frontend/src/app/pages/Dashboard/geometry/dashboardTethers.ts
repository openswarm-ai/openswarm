import { useMemo, type RefObject } from 'react';
import type { CardPosition, BrowserCardPosition, ViewCardPosition } from '@/shared/state/dashboardLayoutSlice';
import { EXPANDED_CARD_MIN_H } from '@/shared/state/dashboardLayoutSlice';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type { Output } from '@/shared/state/outputsSlice';

const ELBOW_RADIUS = 16;

export interface Tether {
  key: string;
  path: string;
  labelX: number;
  labelY: number;
  label: string;
  fading: boolean;
}

interface GlowingAgentCard {
  sourceId: string;
  fading: boolean;
  sourceYRatio?: number;
  label?: string;
}

interface GlowingBrowserCard {
  sourceId: string;
  fading: boolean;
  label?: string;
}

interface LiveDragInfo {
  cardId: string;
  dx: number;
  dy: number;
}

export function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
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

type Anchor = { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' };

interface UseTethersArgs {
  glowingAgentCards: Record<string, GlowingAgentCard>;
  glowingBrowserCards: Record<string, GlowingBrowserCard>;
  cards: Record<string, CardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  outputs: Record<string, Output>;
  expandedSessionIds: string[];
  liveDragInfo: LiveDragInfo | null;
  measuredHeightsRef: RefObject<Record<string, number>>;
  measuredHeightsTick: number;
  sessionList: AgentSession[];
}

export function useTethers({
  glowingAgentCards,
  glowingBrowserCards,
  cards,
  browserCards,
  viewCards,
  outputs,
  expandedSessionIds,
  liveDragInfo,
  measuredHeightsRef,
  measuredHeightsTick,
  sessionList,
}: UseTethersArgs): Tether[] {
  return useMemo(() => {
    const agentTethers = Object.entries(glowingAgentCards).map(([copyId, { sourceId, fading, label }]) => {
      const src = cards[sourceId];
      const dst = cards[copyId];
      if (!src || !dst) return null;

      let srcX = src.x, srcY = src.y;
      let dstX = dst.x, dstY = dst.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === copyId) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }

      const srcMeasured = measuredHeightsRef.current![sourceId];
      const srcH = srcMeasured ?? (expandedSessionIds.includes(sourceId)
        ? Math.max(EXPANDED_CARD_MIN_H, src.height)
        : src.height);
      const dstMeasured = measuredHeightsRef.current![copyId];
      const dstH = dstMeasured ?? (expandedSessionIds.includes(copyId)
        ? Math.max(EXPANDED_CARD_MIN_H, dst.height)
        : dst.height);

      const x1 = srcX + src.width;
      const y1 = srcY + srcH * 0.54;
      const x2 = dstX;
      const y2 = dstY + dstH * (expandedSessionIds.includes(copyId) ? 0.54 : 0.79);
      const midX = x1 + (x2 - x1) / 2;
      const labelX = midX + (x2 - midX) * 0.15;
      const labelY = y2;

      return {
        key: copyId,
        path: elbowPath(x1, y1, x2, y2),
        labelX,
        labelY,
        label: label || '',
        fading,
      };
    }).filter(Boolean) as Tether[];

    // One tether builder for both browser and view cards: the anchor-pairing
    // and elbow/vertical path are identical; only the destination card map and
    // the key prefix differ, so the resolved dst card is passed in.
    function cardTether(
      dst: { x: number; y: number; width: number; height: number } | undefined,
      dstId: string,
      sourceId: string,
      key: string,
      label: string,
      fading: boolean,
    ): Tether | null {
      const src = cards[sourceId];
      if (!src || !dst) return null;

      let srcX = src.x, srcY = src.y;
      let dstX = dst.x, dstY = dst.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === dstId) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }

      const srcMeasured = measuredHeightsRef.current![sourceId];
      const srcH = srcMeasured ?? (expandedSessionIds.includes(sourceId)
        ? Math.max(EXPANDED_CARD_MIN_H, src.height)
        : src.height);
      const dstH = dst.height;

      const srcCx = srcX + src.width / 2;
      const dstCx = dstX + dst.width / 2;

      const srcAnchors: Anchor[] = [
        { x: srcX + src.width, y: srcY + srcH * 0.54, side: 'right' },
        { x: srcX, y: srcY + srcH * 0.54, side: 'left' },
        { x: srcCx, y: srcY, side: 'top' },
        { x: srcCx, y: srcY + srcH, side: 'bottom' },
      ];
      const dstAnchors: Anchor[] = [
        { x: dstX, y: dstY + dstH * 0.54, side: 'left' },
        { x: dstX + dst.width, y: dstY + dstH * 0.54, side: 'right' },
        { x: dstCx, y: dstY, side: 'top' },
        { x: dstCx, y: dstY + dstH, side: 'bottom' },
      ];

      let bestSrc = srcAnchors[0], bestDst = dstAnchors[0];
      let bestDist = Infinity;
      for (const sa of srcAnchors) {
        for (const da of dstAnchors) {
          const d = Math.hypot(sa.x - da.x, sa.y - da.y);
          if (d < bestDist) { bestDist = d; bestSrc = sa; bestDst = da; }
        }
      }

      const x1 = bestSrc.x, y1 = bestSrc.y;
      const x2 = bestDst.x, y2 = bestDst.y;

      const isVertical = (bestSrc.side === 'top' || bestSrc.side === 'bottom')
        && (bestDst.side === 'top' || bestDst.side === 'bottom');

      let pathD: string;
      if (isVertical) {
        const dx = x2 - x1;
        const dy = y2 - y1;
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
      const labelX = isVertical ? midX : midX + (x2 - midX) * 0.15;
      const labelY = isVertical ? midY + (y2 - midY) * 0.15 : y2;

      return {
        key,
        path: pathD,
        labelX,
        labelY,
        label,
        fading,
      };
    }

    const glowTethers = new Map<string, ReturnType<typeof cardTether>>();
    for (const [browserId, { sourceId, fading, label }] of Object.entries(glowingBrowserCards)) {
      const t = cardTether(
        browserCards[browserId],
        browserId,
        sourceId,
        `browser-${browserId}`,
        label || '',
        fading,
      );
      if (t) glowTethers.set(browserId, t);
    }

    for (const s of sessionList) {
      if (s.mode !== 'browser-agent') continue;
      if (s.status !== 'running' && s.status !== 'waiting_approval') continue;
      if (!s.browser_id || !s.parent_session_id) continue;
      if (glowTethers.has(s.browser_id)) continue;
      const t = cardTether(
        browserCards[s.browser_id],
        s.browser_id,
        s.parent_session_id,
        `browser-${s.browser_id}`,
        '',
        false,
      );
      if (t) glowTethers.set(s.browser_id, t);
    }

    const browserTethers = Array.from(glowTethers.values()).filter(Boolean) as Tether[];

    // Index outputs by their owning session so the per-session lookup below
    // doesn't scan the whole outputs map for every view-builder chat.
    const outputsBySession = new Map<string, string[]>();
    for (const o of Object.values(outputs)) {
      if (!o.session_id) continue;
      const arr = outputsBySession.get(o.session_id);
      if (arr) arr.push(o.id); else outputsBySession.set(o.session_id, [o.id]);
    }

    const viewTethers: Tether[] = [];
    for (const s of sessionList) {
      if (s.mode !== 'view-builder') continue;
      if (s.status !== 'running' && s.status !== 'waiting_approval') continue;
      const outIds = outputsBySession.get(s.id);
      if (!outIds) continue;
      for (const outputId of outIds) {
        if (!viewCards[outputId]) continue;
        const t = cardTether(
          viewCards[outputId],
          outputId,
          s.id,
          `view-${outputId}`,
          'Editing',
          false,
        );
        if (t) viewTethers.push(t);
      }
    }

    return [...agentTethers, ...browserTethers, ...viewTethers];
  // measuredHeightsTick re-runs the memo once ResizeObserver reports a new
  // height after a collapse (the ref read is invisible to the dep checker).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowingAgentCards, glowingBrowserCards, cards, browserCards, viewCards, outputs, expandedSessionIds, liveDragInfo, measuredHeightsTick, sessionList]);
}
