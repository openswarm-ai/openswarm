import { useMemo, type RefObject } from 'react';
import type { CardPosition, BrowserCardPosition, ViewCardPosition, WorkflowCardPosition, WorkflowsHubPosition } from '@/shared/state/dashboardLayoutSlice';
import type { Workflow, OpenCard } from '@/shared/state/workflowsSlice';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type { Output } from '@/shared/state/outputsSlice';
import { agentCardHeight } from './agentCardHeight';

const ELBOW_RADIUS = 16;
// Screen pixels, divided by the committed zoom so the head and the label hold their size at any
// camera; the line itself uses a non-scaling stroke in the layer.
export const HEAD_PX = 9;
export const LABEL_FONT_PX = 11;
// Below this a label would be under 5px tall; the line still shows where the link goes.
export const LABEL_MIN_ZOOM = 0.4;
// A lone line leaves an edge at the historical 54% spot; several share the band below so they
// never stack on top of each other for their first segment.
const SINGLE_AT = 0.54;
const FAN_FROM = 0.4;
const FAN_TO = 0.72;

export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Anchor { x: number; y: number; side: Side }
export interface Rect { x: number; y: number; width: number; height: number }

export interface Tether {
  key: string;
  path: string;
  /** The filled arrowhead, drawn as geometry (a marker would scale with the camera). */
  head: string;
  labelX: number;
  labelY: number;
  label: string;
  /** 1 / zoom: the label group scales by this so its text stays LABEL_FONT_PX on screen. */
  labelScale: number;
  fading: boolean;
  /** A spawn glow (the "just happened" cue) wears a halo; a steady link stays a plain line. */
  glow: boolean;
}

interface GlowingAgentCard { sourceId: string; fading: boolean; sourceYRatio?: number; label?: string }
interface GlowingBrowserCard { sourceId: string; fading: boolean; label?: string }

export interface LiveDragInfo { cardId: string; dx: number; dy: number }

/** The few session facts the tethers read. A projection, so streamed messages never re-run the geometry. */
export type TetherSession = Pick<AgentSession, 'id' | 'mode' | 'status' | 'browser_id' | 'parent_session_id' | 'workflow_edit_id'>;

// ---------- pure geometry ----------

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * The pair of FACING edges. The axis with the wider gap between the two cards decides, so a line
 * always leaves perpendicular to one card and enters perpendicular to the other, and can never
 * loop back across the card it started from (the nearest-anchor search could pair a right edge
 * with a top edge and then drive a horizontal segment sideways into that top edge).
 */
export function pickSides(src: Rect, dst: Rect): { src: Side; dst: Side } {
  const sc = center(src);
  const dc = center(dst);
  const dx = dc.x - sc.x;
  const dy = dc.y - sc.y;
  const gapX = dx >= 0 ? dst.x - (src.x + src.width) : src.x - (dst.x + dst.width);
  const gapY = dy >= 0 ? dst.y - (src.y + src.height) : src.y - (dst.y + dst.height);
  if (gapX >= gapY) return dx >= 0 ? { src: 'right', dst: 'left' } : { src: 'left', dst: 'right' };
  return dy >= 0 ? { src: 'bottom', dst: 'top' } : { src: 'top', dst: 'bottom' };
}

function anchorAt(r: Rect, side: Side, fraction: number): Anchor {
  switch (side) {
    case 'left': return { x: r.x, y: r.y + r.height * fraction, side };
    case 'right': return { x: r.x + r.width, y: r.y + r.height * fraction, side };
    case 'top': return { x: r.x + r.width * fraction, y: r.y, side };
    default: return { x: r.x + r.width * fraction, y: r.y + r.height, side };
  }
}

/** Where along an edge each of n lines leaves it: one line at the middle spot, several spread across the band. */
export function fanFractions(n: number): number[] {
  if (n <= 1) return [SINGLE_AT];
  return Array.from({ length: n }, (_, i) => FAN_FROM + ((FAN_TO - FAN_FROM) * i) / (n - 1));
}

/** Left/right pairs: out, across, in. Rounded at both bends. */
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

/** Top/bottom pairs: the same elbow turned on its side. */
export function verticalElbowPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const midY = y1 + dy / 2;
  const r = (Math.abs(dx) < 1 || Math.abs(dy) < ELBOW_RADIUS * 2)
    ? 0
    : Math.min(ELBOW_RADIUS, Math.abs(dx) / 2, Math.abs(dy) / 4);
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  return [
    `M ${x1},${y1}`,
    `V ${midY - sy * r}`,
    `Q ${x1},${midY} ${x1 + sx * r},${midY}`,
    `H ${x2 - sx * r}`,
    `Q ${x2},${midY} ${x2},${midY + sy * r}`,
    `V ${y2}`,
  ].join(' ');
}

/** Unit direction the line travels as it enters a card through `side`. */
function entryDirection(side: Side): { x: number; y: number } {
  switch (side) {
    case 'left': return { x: 1, y: 0 };
    case 'right': return { x: -1, y: 0 };
    case 'top': return { x: 0, y: 1 };
    default: return { x: 0, y: -1 };
  }
}

/** A filled triangle whose tip sits on the card edge, pointing the way the line travels. */
export function headPath(tip: Anchor, size: number): string {
  const d = entryDirection(tip.side);
  const bx = tip.x - d.x * size;
  const by = tip.y - d.y * size;
  const px = -d.y * size * 0.5;
  const py = d.x * size * 0.5;
  return `M ${tip.x},${tip.y} L ${bx + px},${by + py} L ${bx - px},${by - py} Z`;
}

export interface Routed { path: string; head: string; labelX: number; labelY: number }

/** The line stops short of the tip so the stroke never pokes through the head. */
export function route(a: Anchor, b: Anchor, headSize: number): Routed {
  const d = entryDirection(b.side);
  const shorten = headSize * 0.7;
  const ex = b.x - d.x * shorten;
  const ey = b.y - d.y * shorten;
  const horizontal = a.side === 'left' || a.side === 'right';
  const path = horizontal ? elbowPath(a.x, a.y, ex, ey) : verticalElbowPath(a.x, a.y, ex, ey);
  return {
    path,
    head: headPath(b, headSize),
    labelX: a.x + (b.x - a.x) / 2,
    labelY: a.y + (b.y - a.y) / 2,
  };
}

// ---------- links ----------

interface Link {
  key: string;
  srcId: string;
  src: Rect;
  dstId: string;
  dst: Rect;
  label: string;
  fading: boolean;
  glow: boolean;
}

function shifted(r: Rect, id: string, drag: LiveDragInfo | null): Rect {
  return drag && drag.cardId === id ? { ...r, x: r.x + drag.dx, y: r.y + drag.dy } : r;
}

/**
 * Sides first, then anchors: every link leaving the same edge of the same card gets its own spot
 * along that edge, ordered by where its other end sits, so lines fan out instead of overprinting.
 */
export function layoutLinks(links: Link[], zoom: number): Tether[] {
  const sides = links.map((l) => pickSides(l.src, l.dst));
  const along = (side: Side, r: Rect): number => (side === 'left' || side === 'right' ? center(r).y : center(r).x);
  const fractionFor = (which: 'src' | 'dst'): number[] => {
    const out = new Array<number>(links.length).fill(SINGLE_AT);
    const groups = new Map<string, number[]>();
    links.forEach((l, i) => {
      const id = which === 'src' ? l.srcId : l.dstId;
      const key = `${id}|${sides[i][which]}`;
      const g = groups.get(key);
      if (g) g.push(i); else groups.set(key, [i]);
    });
    for (const [, idx] of groups) {
      if (idx.length === 1) continue;
      const side = sides[idx[0]][which];
      idx.sort((p, q) => along(side, which === 'src' ? links[p].dst : links[p].src) - along(side, which === 'src' ? links[q].dst : links[q].src));
      const fr = fanFractions(idx.length);
      idx.forEach((i, k) => { out[i] = fr[k]; });
    }
    return out;
  };
  const srcFr = fractionFor('src');
  const dstFr = fractionFor('dst');
  const headSize = HEAD_PX / Math.max(zoom, 0.05);
  return links.map((l, i) => {
    const a = anchorAt(l.src, sides[i].src, srcFr[i]);
    const b = anchorAt(l.dst, sides[i].dst, dstFr[i]);
    const r = route(a, b, headSize);
    return { key: l.key, path: r.path, head: r.head, labelX: r.labelX, labelY: r.labelY, label: l.label, labelScale: 1 / Math.max(zoom, 0.05), fading: l.fading, glow: l.glow };
  });
}

// ---------- the hook ----------

export interface TetherInputs {
  glowingAgentCards: Record<string, GlowingAgentCard>;
  glowingBrowserCards: Record<string, GlowingBrowserCard>;
  cards: Record<string, CardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowItems: Record<string, Workflow>;
  workflowOpenCards: Record<string, OpenCard>;
  viewCards: Record<string, ViewCardPosition>;
  outputs: Record<string, Output>;
  expandedSessionIds: string[];
  measuredHeightsRef: RefObject<Record<string, number>>;
  measuredHeightsTick: number;
  sessions: TetherSession[];
  workflowsHub: WorkflowsHubPosition | null;
  workflowsMonitorCard: WorkflowsHubPosition | null;
  workflowsMonitorLabel: string;
  /** Session id of the run the monitor is showing; its browser tethers to the monitor card, not a (suppressed) standalone agent card. */
  monitorRunSessionId: string | null;
  /** The committed camera zoom; heads and labels are sized against it. */
  zoom: number;
}

export function useTethers(inputs: TetherInputs, liveDragInfo: LiveDragInfo | null): Tether[] {
  const {
    glowingAgentCards, glowingBrowserCards, cards, browserCards, workflowCards, workflowItems, workflowOpenCards,
    viewCards, outputs, expandedSessionIds, measuredHeightsRef, measuredHeightsTick, sessions,
    workflowsHub, workflowsMonitorCard, workflowsMonitorLabel, monitorRunSessionId, zoom,
  } = inputs;
  return useMemo(() => {
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const expandedSet = new Set(expandedSessionIds);
    const measured = measuredHeightsRef.current;
    // A collapsed chat renders as a pill that already previews its browser, so an arrow from the
    // pill duplicates the link and reads as clutter; arrows only make sense from an OPEN chat.
    const sourceIsCollapsedChat = (sid: string): boolean =>
      sid !== monitorRunSessionId && sessionById.has(sid) && !expandedSet.has(sid);
    const agentRect = (id: string, c: CardPosition): Rect => ({ x: c.x, y: c.y, width: c.width, height: agentCardHeight(id, c.height, expandedSet.has(id), measured) });
    const wfRect = (wc: WorkflowCardPosition): Rect => ({ x: wc.x, y: wc.y, width: wc.width, height: measured?.[wc.workflow_id] ?? wc.height });
    const plainRect = (r: { x: number; y: number; width: number; height: number }): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

    // Workflow chats have no standalone agent card: a run anchors to the monitor card, an edit/compose
    // chat to the hub window, so a browser tether lands on the workflow surface instead of nothing.
    const sourceRect = (sourceId: string): { id: string; rect: Rect } | null => {
      const srcSession = sessionById.get(sourceId);
      if (workflowsMonitorCard && sourceId === monitorRunSessionId) return { id: 'workflows-monitor', rect: plainRect(workflowsMonitorCard) };
      if (workflowsHub && srcSession?.workflow_edit_id) return { id: 'workflows-hub', rect: plainRect(workflowsHub) };
      const c = cards[sourceId];
      return c ? { id: sourceId, rect: agentRect(sourceId, c) } : null;
    };

    const links: Link[] = [];
    const cardTether = (dst: Rect | undefined, dstId: string, sourceId: string, key: string, label: string, fading: boolean, glow: boolean): void => {
      const src = sourceRect(sourceId);
      if (!src || !dst) return;
      links.push({ key, srcId: src.id, src: shifted(src.rect, src.id, liveDragInfo), dstId, dst: shifted(dst, dstId, liveDragInfo), label, fading, glow });
    };

    // Spawn glow: the parent-to-child cue, halo and label, fading after the card has settled.
    const agentTethers = new Set<string>();
    for (const [childId, { sourceId, fading, label }] of Object.entries(glowingAgentCards)) {
      if (!cards[sourceId] || !cards[childId]) continue;
      agentTethers.add(childId);
      cardTether(agentRect(childId, cards[childId]), childId, sourceId, childId, label || '', fading, true);
    }
    // A steady link while a child WORKS: after the glow has faded, the only other way to tell which
    // pill belongs to which chat was position. Quiet (no halo, no label) and gone when the child rests.
    for (const s of sessions) {
      if (!s.parent_session_id || agentTethers.has(s.id)) continue;
      if (s.status !== 'running' && s.status !== 'waiting_approval') continue;
      if (s.mode === 'browser-agent') continue;
      if (!cards[s.id] || !cards[s.parent_session_id] || sourceIsCollapsedChat(s.parent_session_id)) continue;
      cardTether(agentRect(s.id, cards[s.id]), s.id, s.parent_session_id, `child-${s.id}`, '', false, false);
    }

    // An "app:<output_id>" glow key targets a VIEW card (AppAgent driving an app); everything else is a browser card.
    const glowTarget = (id: string) => (id.startsWith('app:') ? viewCards[id.slice(4)] : browserCards[id]);
    const browserLinked = new Set<string>();
    for (const [browserId, { sourceId, fading, label }] of Object.entries(glowingBrowserCards)) {
      const target = glowTarget(browserId);
      // A docked card (browser OR app) renders INSIDE its chat; an arrow to it points at nothing.
      if (!target || target.docked_to) continue;
      if (sourceIsCollapsedChat(sourceId)) continue;
      browserLinked.add(browserId);
      cardTether(plainRect(target), browserId, sourceId, `browser-${browserId}`, label || '', fading, true);
    }
    for (const s of sessions) {
      if (s.mode !== 'browser-agent') continue;
      if (s.status !== 'running' && s.status !== 'waiting_approval') continue;
      if (!s.browser_id || !s.parent_session_id || browserLinked.has(s.browser_id)) continue;
      const target = browserCards[s.browser_id];
      if (!target || target.docked_to) continue;
      if (sourceIsCollapsedChat(s.parent_session_id)) continue;
      // A browser docked below the hub keeps a "Browser" pointer so the link reads at a glance.
      const parent = sessionById.get(s.parent_session_id);
      browserLinked.add(s.browser_id);
      cardTether(plainRect(target), s.browser_id, s.parent_session_id, `browser-${s.browser_id}`, parent?.workflow_edit_id ? 'Browser' : '', false, false);
    }

    // "Make workflow" is a draft-time affordance: the chat that authored a workflow card, until it is saved.
    for (const wc of Object.values(workflowCards)) {
      const sourceId = wc.source_session_id;
      if (!sourceId || !cards[sourceId]) continue;
      if (!(wc.workflow_id in workflowItems) && !(wc.workflow_id in workflowOpenCards)) continue;
      const openCard = workflowOpenCards[wc.workflow_id];
      if (openCard && openCard.view !== 'preview') continue;
      cardTether(wfRect(wc), wc.workflow_id, sourceId, `workflow-${wc.workflow_id}`, 'Make workflow', false, false);
    }
    // Sidecar: a workflow card to the sibling chat that watches or tests it.
    for (const wc of Object.values(workflowCards)) {
      const openCard = workflowOpenCards[wc.workflow_id];
      if (!openCard?.sidecarSessionId || !openCard.sidecarKind) continue;
      const sidecar = cards[openCard.sidecarSessionId];
      if (!sidecar) continue;
      links.push({
        key: `sidecar-${wc.workflow_id}`,
        srcId: wc.workflow_id,
        src: shifted(wfRect(wc), wc.workflow_id, liveDragInfo),
        dstId: openCard.sidecarSessionId,
        dst: shifted(agentRect(openCard.sidecarSessionId, sidecar), openCard.sidecarSessionId, liveDragInfo),
        label: openCard.sidecarKind === 'testing' ? 'Testing' : 'Watching',
        fading: false,
        glow: false,
      });
    }
    // The Workflows window to its live-run monitor card.
    if (workflowsHub && workflowsMonitorCard) {
      links.push({
        key: 'workflows-monitor',
        srcId: 'workflows-hub',
        src: shifted(plainRect(workflowsHub), 'workflows-hub', liveDragInfo),
        dstId: 'workflows-monitor',
        dst: shifted(plainRect(workflowsMonitorCard), 'workflows-monitor', liveDragInfo),
        label: workflowsMonitorLabel,
        fading: false,
        glow: false,
      });
    }

    // An app builder chat to the app it is editing, while it works.
    const outputsBySession = new Map<string, string[]>();
    for (const o of Object.values(outputs)) {
      if (!o.session_id) continue;
      const arr = outputsBySession.get(o.session_id);
      if (arr) arr.push(o.id); else outputsBySession.set(o.session_id, [o.id]);
    }
    for (const s of sessions) {
      if (s.mode !== 'view-builder') continue;
      if (s.status !== 'running' && s.status !== 'waiting_approval') continue;
      for (const outputId of outputsBySession.get(s.id) ?? []) {
        const vc = viewCards[outputId];
        if (!vc || vc.docked_to) continue;
        cardTether(plainRect(vc), outputId, s.id, `view-${outputId}`, 'Editing', false, false);
      }
    }

    return layoutLinks(links, zoom);
  // measuredHeightsTick re-runs the memo once ResizeObserver reports a new height after a collapse (the ref read is invisible to the dep checker). eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowingAgentCards, glowingBrowserCards, cards, browserCards, workflowCards, workflowItems, workflowOpenCards, viewCards, outputs, expandedSessionIds, liveDragInfo, measuredHeightsTick, sessions, workflowsHub, workflowsMonitorCard, workflowsMonitorLabel, monitorRunSessionId, zoom]);
}
