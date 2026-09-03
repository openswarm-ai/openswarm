import { useMemo, type RefObject } from 'react';
import type { CardPosition, BrowserCardPosition, ViewCardPosition, WorkflowCardPosition, WorkflowsHubPosition } from '@/shared/state/dashboardLayoutSlice';
import type { Workflow, OpenCard } from '@/shared/state/workflowsSlice';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type { Output } from '@/shared/state/outputsSlice';
import { agentCardHeight } from './agentCardHeight';

import { HEAD_PX, SINGLE_AT, anchorAt, center, fanFractions, pickSides, route } from './tetherGeometry';
import type { Rect, Side } from './tetherTypes';

export { HEAD_PX, LABEL_FONT_PX, LABEL_MIN_ZOOM, pickSides, fanFractions, headPath, route, elbowPath, verticalElbowPath } from './tetherGeometry';
export type { Rect, Side, Anchor, Routed } from './tetherTypes';

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
