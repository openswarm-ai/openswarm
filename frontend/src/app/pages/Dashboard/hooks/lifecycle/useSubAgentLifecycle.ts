import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { collapseSession, expandSession, type AgentSession } from '@/shared/state/agentsSlice';
import {
  placeCard,
  removeCard,
  setGlowingAgentCard,
  clearGlowingAgentCard,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
  type CardPosition,
} from '@/shared/state/dashboardLayoutSlice';

interface UseSubAgentLifecycleArgs {
  isActive: boolean;
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  layoutInitialized: boolean;
  autoRevealSubAgents: boolean;
  expandedSessionIds: string[];
}

export function useSubAgentLifecycle({
  isActive,
  sessions,
  cards,
  layoutInitialized,
  autoRevealSubAgents,
  expandedSessionIds,
}: UseSubAgentLifecycleArgs) {
  const dispatch = useAppDispatch();

  const autoRevealedRef = useRef(new Set<string>());
  const prevSubStatusRef = useRef<Record<string, string>>({});
  const prevParentStatusRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!isActive) return;  // Heavy logic , pause when dashboard is hidden
    if (!layoutInitialized || !autoRevealSubAgents) return;

    const subSessions = Object.values(sessions).filter(
      (s) => (s.mode === 'sub-agent' || s.mode === 'invoked-agent') && s.parent_session_id,
    );

    // 1) Auto-reveal newly spawned sub-agents (skip already-terminal ones on load)
    for (const sub of subSessions) {
      if (autoRevealedRef.current.has(sub.id)) continue;
      if (cards[sub.id]) {
        autoRevealedRef.current.add(sub.id);
        continue;
      }
      const parentCard = cards[sub.parent_session_id!];
      if (!parentCard) continue;

      const isTerminal = sub.status === 'completed' || sub.status === 'error' || sub.status === 'stopped';
      const parentSession = sessions[sub.parent_session_id!];
      const parentTerminal = parentSession &&
        (parentSession.status === 'completed' || parentSession.status === 'error' || parentSession.status === 'stopped');
      if (isTerminal && parentTerminal) {
        autoRevealedRef.current.add(sub.id);
        continue;
      }

      autoRevealedRef.current.add(sub.id);

      const targetX = parentCard.x + parentCard.width + GRID_GAP * 12;
      let targetY = parentCard.y;
      const columnCards = Object.values(cards).filter(
        (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== sub.id,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }

      dispatch(placeCard({
        sessionId: sub.id,
        x: targetX,
        y: targetY,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
        // Pass the current expanded-session set so placeCard's
        // collision check uses real visual heights (expanded cards
        // render ~620px tall instead of their stored collapsed
        // height). Without this, sub-agents spawn into space the
        // parent card visually occupies.
        expandedSessionIds,
      }));
      dispatch(expandSession(sub.id));
      const label = sub.mode === 'sub-agent' ? 'Create Agent' : 'Invoke Agent';
      dispatch(setGlowingAgentCard({ sessionId: sub.id, sourceId: sub.parent_session_id!, label }));

      if (sub.status === 'completed' || sub.status === 'error' || sub.status === 'stopped') {
        const subId = sub.id;
        setTimeout(() => dispatch(collapseSession(subId)), 2000);
      }
    }

    // 2) Auto-collapse sub-agents when they complete
    const TERMINAL = new Set(['completed', 'error', 'stopped']);
    for (const sub of subSessions) {
      const prev = prevSubStatusRef.current[sub.id];
      if (prev !== sub.status && TERMINAL.has(sub.status) && cards[sub.id]) {
        dispatch(collapseSession(sub.id));
      }
    }
    const newSubStatuses: Record<string, string> = {};
    for (const sub of subSessions) { newSubStatuses[sub.id] = sub.status; }
    prevSubStatusRef.current = newSubStatuses;

    // 3) Unreveal all sub-agent cards when parent finishes output
    const parentIds = new Set(subSessions.map((s) => s.parent_session_id!));
    for (const pid of parentIds) {
      const parent = sessions[pid];
      if (!parent) continue;
      const prev = prevParentStatusRef.current[pid];
      if (prev !== parent.status && TERMINAL.has(parent.status)) {
        const children = subSessions.filter((s) => s.parent_session_id === pid);
        for (const child of children) {
          if (!cards[child.id]) continue;
          dispatch(collapseSession(child.id));
          dispatch(removeCard(child.id));
          setTimeout(() => {
            dispatch(clearGlowingAgentCard(child.id));
          }, 500);
        }
      }
    }
    const newParentStatuses: Record<string, string> = {};
    for (const pid of parentIds) {
      const parent = sessions[pid];
      if (parent) newParentStatuses[pid] = parent.status;
    }
    prevParentStatusRef.current = newParentStatuses;
  }, [isActive, sessions, cards, layoutInitialized, autoRevealSubAgents, dispatch]);
}
