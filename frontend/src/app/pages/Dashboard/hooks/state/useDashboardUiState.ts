import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardPosition } from '@/shared/state/dashboardLayoutSlice';
import type { useDashboardSelection } from './useDashboardSelection';

type Selection = ReturnType<typeof useDashboardSelection>;
type SpawnOrigin = { x: number; y: number; type?: 'branch' };

// Bundles the dashboard's purely-local UI bookkeeping (highlight pulse,
// auto-focus, pending-select, measured heights, reveal tracking) so
// Dashboard.tsx stays a thin composition layer. selection + cards come in
// from the parent because the pending-select effect needs both.
export function useDashboardUiState(selection: Selection, cards: Record<string, CardPosition>) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoFocusSessionId, setAutoFocusSessionId] = useState<string | null>(null);
  const [pendingSelectSessionId, setPendingSelectSessionId] = useState<string | null>(null);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [newAgentBounce, setNewAgentBounce] = useState(false);
  // Cleanup any leftover walkthrough localStorage from v1 , the v2 panel
  // ignores it but it would otherwise hang around forever.
  useEffect(() => {
    try {
      localStorage.removeItem('openswarm_walkthrough_pending');
    } catch { /* ignore */ }
  }, []);

  const handleHighlightCard = useCallback((cardId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedCardId(cardId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedCardId(null);
      highlightTimerRef.current = null;
    }, 2000);
  }, []);

  useEffect(() => {
    if (autoFocusSessionId) {
      const timer = setTimeout(() => setAutoFocusSessionId(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [autoFocusSessionId]);

  useEffect(() => {
    if (!pendingSelectSessionId) return;
    if (!cards[pendingSelectSessionId]) return;
    setPendingSelectSessionId(null);
    selection.selectCard(pendingSelectSessionId, 'agent', false);
  }, [pendingSelectSessionId, cards, selection]);

  const spawnOriginsRef = useRef<Record<string, SpawnOrigin>>({});
  const measuredHeightsRef = useRef<Record<string, number>>({});
  const [measuredHeightsTick, setMeasuredHeightsTick] = useState(0);
  const handleMeasuredHeight = useCallback((sessionId: string, height: number) => {
    if (measuredHeightsRef.current[sessionId] !== height) {
      measuredHeightsRef.current[sessionId] = height;
      setMeasuredHeightsTick((t) => t + 1);
    }
  }, []);
  const revealSpawnedRef = useRef(new Set<string>());
  useEffect(() => {
    revealSpawnedRef.current.forEach((id) => {
      if (!cards[id]) revealSpawnedRef.current.delete(id);
    });
  }, [cards]);
  const hasFittedRef = useRef(false);
  const restoredExpandedRef = useRef(false);

  return {
    toolbarRef,
    toolbarOpen,
    setToolbarOpen,
    searchPaletteOpen,
    setSearchPaletteOpen,
    highlightedCardId,
    handleHighlightCard,
    autoFocusSessionId,
    setAutoFocusSessionId,
    setPendingSelectSessionId,
    focusedCardId,
    setFocusedCardId,
    newAgentBounce,
    setNewAgentBounce,
    spawnOriginsRef,
    measuredHeightsRef,
    measuredHeightsTick,
    handleMeasuredHeight,
    revealSpawnedRef,
    hasFittedRef,
    restoredExpandedRef,
  };
}
