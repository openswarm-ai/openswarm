import { useMemo, type RefObject } from 'react';
import type { CardPosition, BrowserCardPosition, WorkflowCardPosition, ConfigurePanelPosition } from '@/shared/state/dashboardLayoutSlice';
import type { Workflow, OpenCard } from '@/shared/state/workflowsSlice';
import { EXPANDED_CARD_MIN_H, GRID_GAP } from '@/shared/state/dashboardLayoutSlice';
import type { AgentSession } from '@/shared/state/agentsSlice';

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
type CanvasRect = { x: number; y: number; width: number; height: number };

// Where the ray from a rect's center toward (tx,ty) crosses the rect border.
// Pins a tether endpoint to the card edge facing the other card, so it can
// never float in empty space the way nearest-corner anchoring could.
function borderPoint(x: number, y: number, w: number, h: number, tx: number, ty: number): { x: number; y: number } {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function rectCenter(r: CanvasRect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function selectCardElement(content: HTMLElement, type: 'agent-card' | 'workflow-card', id: string): HTMLElement | null {
  const candidates = content.querySelectorAll<HTMLElement>(`[data-select-type="${type}"]`);
  for (const el of Array.from(candidates)) {
    if (el.dataset.selectId === id) return el;
  }
  return null;
}

function measuredCanvasRect(
  contentRef: RefObject<HTMLElement>,
  zoom: number,
  type: 'agent-card' | 'workflow-card',
  id: string,
): CanvasRect | null {
  const content = contentRef.current;
  if (!content) return null;
  const el = selectCardElement(content, type, id);
  if (!el) return null;
  const contentRect = content.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const z = zoom || 1;
  return {
    x: (elRect.left - contentRect.left) / z,
    y: (elRect.top - contentRect.top) / z,
    width: elRect.width / z,
    height: elRect.height / z,
  };
}

interface UseTethersArgs {
  glowingAgentCards: Record<string, GlowingAgentCard>;
  glowingBrowserCards: Record<string, GlowingBrowserCard>;
  cards: Record<string, CardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowItems: Record<string, Workflow>;
  workflowOpenCards: Record<string, OpenCard>;
  configurePanels: Record<string, ConfigurePanelPosition>;
  expandedSessionIds: string[];
  liveDragInfo: LiveDragInfo | null;
  measuredHeightsRef: RefObject<Record<string, number>>;
  measuredHeightsTick: number;
  contentRef: RefObject<HTMLElement>;
  zoom: number;
  sessionList: AgentSession[];
}

export function useTethers({
  glowingAgentCards,
  glowingBrowserCards,
  cards,
  browserCards,
  workflowCards,
  workflowItems,
  workflowOpenCards,
  configurePanels,
  expandedSessionIds,
  liveDragInfo,
  measuredHeightsRef,
  measuredHeightsTick,
  contentRef,
  zoom,
  sessionList,
}: UseTethersArgs): Tether[] {
  return useMemo(() => {
    const wfHeight = (wc: WorkflowCardPosition): number =>
      measuredHeightsRef.current![wc.workflow_id] ?? wc.height;
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

    function browserTether(
      browserId: string,
      sourceId: string,
      fading: boolean,
      label: string,
    ): Tether | null {
      const src = cards[sourceId];
      const dst = browserCards[browserId];
      if (!src || !dst) return null;

      let srcX = src.x, srcY = src.y;
      let dstX = dst.x, dstY = dst.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === browserId) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
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
        key: `browser-${browserId}`,
        path: pathD,
        labelX,
        labelY,
        label,
        fading,
      };
    }

    const glowTethers = new Map<string, ReturnType<typeof browserTether>>();
    for (const [browserId, { sourceId, fading, label }] of Object.entries(glowingBrowserCards)) {
      const t = browserTether(browserId, sourceId, fading, label || '');
      if (t) glowTethers.set(browserId, t);
    }

    for (const s of sessionList) {
      if (s.mode !== 'browser-agent') continue;
      if (s.status !== 'running' && s.status !== 'waiting_approval') continue;
      if (!s.browser_id || !s.parent_session_id) continue;
      if (glowTethers.has(s.browser_id)) continue;
      const t = browserTether(s.browser_id, s.parent_session_id, false, '');
      if (t) glowTethers.set(s.browser_id, t);
    }

    const browserTethers = Array.from(glowTethers.values()).filter(Boolean) as Tether[];

    // Workflow tethers reuse the browser-tether anchor/elbow math; skip deleted workflows to avoid dangling arrows.
    const workflowTethers: Tether[] = [];
    for (const wc of Object.values(workflowCards)) {
      const sourceId = wc.source_session_id;
      if (!sourceId) continue;
      const src = cards[sourceId];
      if (!src) continue;
      // Layout entry can outlive its workflow when deleted from the hub.
      const hasReal = wc.workflow_id in workflowItems;
      const hasDraft = wc.workflow_id in workflowOpenCards;
      if (!hasReal && !hasDraft) continue;
      // "Make workflow" is a draft-time affordance; once saved (openCard leaves 'preview') the link retires.
      const openCard = workflowOpenCards[wc.workflow_id];
      if (openCard && openCard.view !== 'preview') continue;

      let srcX = src.x, srcY = src.y;
      let dstX = wc.x, dstY = wc.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === wc.workflow_id) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }

      const srcMeasured = measuredHeightsRef.current![sourceId];
      const srcH = srcMeasured ?? (expandedSessionIds.includes(sourceId)
        ? Math.max(EXPANDED_CARD_MIN_H, src.height)
        : src.height);

      const wcH = wfHeight(wc);
      const srcCx = srcX + src.width / 2;
      const dstCx = dstX + wc.width / 2;
      const srcAnchors: Anchor[] = [
        { x: srcX + src.width, y: srcY + srcH * 0.54, side: 'right' },
        { x: srcX, y: srcY + srcH * 0.54, side: 'left' },
        { x: srcCx, y: srcY, side: 'top' },
        { x: srcCx, y: srcY + srcH, side: 'bottom' },
      ];
      const dstAnchors: Anchor[] = [
        { x: dstX, y: dstY + wcH * 0.54, side: 'left' },
        { x: dstX + wc.width, y: dstY + wcH * 0.54, side: 'right' },
        { x: dstCx, y: dstY, side: 'top' },
        { x: dstCx, y: dstY + wcH, side: 'bottom' },
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
      workflowTethers.push({
        key: `workflow-${wc.workflow_id}`,
        path: pathD,
        labelX,
        labelY,
        label: 'Make workflow',
        fading: false,
      });
    }

    // Sidecar tethers: workflow card to its sibling agent session (View Agent / Watch Live / Test Agent).
    for (const wc of Object.values(workflowCards)) {
      const openCard = workflowOpenCards[wc.workflow_id];
      if (!openCard?.sidecarSessionId || !openCard.sidecarKind) continue;
      const sidecarId = openCard.sidecarSessionId;
      const sidecar = cards[sidecarId];
      if (!sidecar) continue;
      let srcX = wc.x, srcY = wc.y;
      let dstX = sidecar.x, dstY = sidecar.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === wc.workflow_id) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === sidecarId) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }
      const dstMeasured = measuredHeightsRef.current![sidecarId];
      const dstH = dstMeasured ?? (expandedSessionIds.includes(sidecarId)
        ? Math.max(EXPANDED_CARD_MIN_H, sidecar.height)
        : sidecar.height);
      const wcH = wfHeight(wc);
      const measuredWorkflow = measuredCanvasRect(contentRef, zoom, 'workflow-card', wc.workflow_id);
      const measuredSidecar = measuredCanvasRect(contentRef, zoom, 'agent-card', sidecarId);
      const workflowRect = measuredWorkflow ?? { x: srcX, y: srcY, width: wc.width, height: wcH };
      const sidecarRect = measuredSidecar ?? { x: dstX, y: dstY, width: sidecar.width, height: dstH };
      const srcCenter = rectCenter(workflowRect);
      const dstCenter = rectCenter(sidecarRect);
      const a = borderPoint(workflowRect.x, workflowRect.y, workflowRect.width, workflowRect.height, dstCenter.x, dstCenter.y);
      const b = borderPoint(sidecarRect.x, sidecarRect.y, sidecarRect.width, sidecarRect.height, srcCenter.x, srcCenter.y);
      const x1 = a.x, y1 = a.y;
      const x2 = b.x, y2 = b.y;
      const pathD = elbowPath(x1, y1, x2, y2);
      const midX = x1 + (x2 - x1) / 2;
      const midY = y1 + (y2 - y1) / 2;
      const sidecarLabel = openCard.sidecarKind === 'testing' ? 'Testing' : 'Watching';
      workflowTethers.push({
        key: `sidecar-${wc.workflow_id}`,
        path: pathD,
        labelX: midX,
        labelY: midY,
        label: sidecarLabel,
        fading: false,
      });
    }

    // Configure-panel tethers: anchor each open configure panel to its workflow card.
    const configureTethers: Tether[] = [];
    for (const p of Object.values(configurePanels)) {
      const wc = workflowCards[p.workflow_id];
      if (!wc) continue;
      let srcX = wc.x, srcY = wc.y;
      let dstX = p.x, dstY = p.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === p.workflow_id) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
      }
      const wcH = wfHeight(wc);
      const srcCx = srcX + wc.width / 2;
      const dstCx = dstX + p.width / 2;
      const srcAnchors: Anchor[] = [
        { x: srcX + wc.width, y: srcY + wcH * 0.5, side: 'right' },
        { x: srcX, y: srcY + wcH * 0.5, side: 'left' },
        { x: srcCx, y: srcY, side: 'top' },
        { x: srcCx, y: srcY + wcH, side: 'bottom' },
      ];
      const dstAnchors: Anchor[] = [
        { x: dstX, y: dstY + p.height * 0.5, side: 'left' },
        { x: dstX + p.width, y: dstY + p.height * 0.5, side: 'right' },
        { x: dstCx, y: dstY, side: 'top' },
        { x: dstCx, y: dstY + p.height, side: 'bottom' },
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
      const pathD = elbowPath(x1, y1, x2, y2);
      const midX = x1 + (x2 - x1) / 2;
      const midY = y1 + (y2 - y1) / 2;
      configureTethers.push({
        key: `configure-${p.workflow_id}`,
        path: pathD,
        labelX: midX,
        labelY: midY,
        label: 'Configure',
        fading: false,
      });
    }

    return [...agentTethers, ...browserTethers, ...workflowTethers, ...configureTethers];
  // measuredHeightsTick re-runs the memo once ResizeObserver reports a new
  // height after a collapse (the ref read is invisible to the dep checker).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowingAgentCards, glowingBrowserCards, cards, browserCards, workflowCards, workflowItems, workflowOpenCards, configurePanels, expandedSessionIds, liveDragInfo, measuredHeightsTick, contentRef, zoom, sessionList]);
}
