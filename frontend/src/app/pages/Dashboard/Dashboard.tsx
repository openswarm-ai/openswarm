import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DashboardHeader from './DashboardHeader';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import {
  fetchSessions,
  fetchHistory,
  collapseSession,
  closeSession,
  duplicateSession,
  expandSession,
  launchAndSendFirstMessage,
  generateTitle,
  resumeSession,
  setExpandedSessionIds,
  toggleExpandSession,
} from '@/shared/state/agentsSlice';
import type { AgentConfig } from '@/shared/state/agentsSlice';
import {
  fetchLayout,
  saveLayout,
  reconcileSessions,
  tidyLayout,
  addViewCard,
  addBrowserCard,
  moveCards,
  resetLayout,
  setGlowingBrowserCards,
  removeViewCard,
  removeBrowserCard,
  pasteBrowserCard,
  placeCard,
  setCardPosition,
  removeCard,
  bringToFront,
  setGlowingAgentCard,
  clearGlowingAgentCard,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
} from '@/shared/state/dashboardLayoutSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { generateDashboardName, updateDashboardThumbnail } from '@/shared/state/dashboardsSlice';
import { dashboardWs } from '@/shared/ws/WebSocketManager';
import { initBrowserCommandHandler } from '@/shared/browserCommandHandler';
import { clearPendingBrowserUrl, clearPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import AgentCard from './AgentCard';
import DashboardViewCard from './DashboardViewCard';
import BrowserCard from './BrowserCard';
import CanvasControls from './CanvasControls';
import DashboardToolbar from './DashboardToolbar';
import { captureDashboardThumbnail } from './captureDashboardThumbnail';
import { useCanvasControls } from './useCanvasControls';
import { useDashboardSelection } from './useDashboardSelection';
import type { CardType } from './useDashboardSelection';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ContextPath } from '@/app/components/DirectoryBrowser';
import { ElementSelectionProvider, useElementSelection } from '@/app/components/ElementSelectionContext';
import { useDomElementSelector } from '@/app/components/useDomElementSelector';
import SelectionOverlay from '@/app/components/SelectionOverlay';
import { setClipboardCards, getClipboardCards, type ClipboardCard } from '@/shared/dashboardClipboard';

const SELECT_ATTR = 'data-select-type';

const DashboardSelectionOverlay: React.FC = () => {
  const { overlay, dragRect, dragPreview } = useDomElementSelector();
  return <SelectionOverlay overlay={overlay} dragRect={dragRect} dragPreview={dragPreview} />;
};

function isCardTarget(target: EventTarget | null, boundary: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el && el !== boundary) {
    if (el.hasAttribute(SELECT_ATTR)) return true;
    el = el.parentElement;
  }
  return false;
}

const DashboardInner: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { id: dashboardId } = useParams<{ id: string }>();
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;
  const dashboardName = useAppSelector((state) =>
    dashboardId ? state.dashboards.items[dashboardId]?.name : undefined,
  );
  const sessions = useAppSelector((state) => state.agents.sessions);
  const expandedSessionIds = useAppSelector((state) => state.agents.expandedSessionIds);
  const cards = useAppSelector((state) => state.dashboardLayout.cards);
  const viewCards = useAppSelector((state) => state.dashboardLayout.viewCards);
  const browserCards = useAppSelector((state) => state.dashboardLayout.browserCards);
  const layoutInitialized = useAppSelector((state) => state.dashboardLayout.initialized);
  const persistedExpandedSessionIds = useAppSelector((state) => state.dashboardLayout.persistedExpandedSessionIds);
  const zoomSensitivity = useAppSelector((state) => state.settings.data.zoom_sensitivity);
  const newAgentShortcut = useAppSelector((state) => state.settings.data.new_agent_shortcut);
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const expandNewChats = useAppSelector((state) => state.settings.data.expand_new_chats_in_dashboard);
  const autoRevealSubAgents = useAppSelector((state) => state.settings.data.auto_reveal_sub_agents);
  const outputs = useAppSelector((state) => state.outputs.items);
  const glowingAgentCards = useAppSelector((state) => state.dashboardLayout.glowingAgentCards);
  const glowingBrowserCards = useAppSelector((state) => state.dashboardLayout.glowingBrowserCards);
  const sessionList = Object.values(sessions);

  const canvas = useCanvasControls(zoomSensitivity);
  const selection = useDashboardSelection(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, viewportRef: canvas.viewportRef },
    cards,
    viewCards,
    browserCards,
  );
  const toolbarRef = useRef<HTMLDivElement>(null);

  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoFocusSessionId, setAutoFocusSessionId] = useState<string | null>(null);
  const [pendingSelectSessionId, setPendingSelectSessionId] = useState<string | null>(null);

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

  const spawnOriginsRef = useRef<Record<string, { x: number; y: number; type?: 'branch' }>>({});
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
  const canvasStateRef = useRef({ panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom });
  canvasStateRef.current = { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom };

  // ---- Multi-drag coordination ----
  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<{ cardId: string; dx: number; dy: number } | null>(null);
  const activeDragCardRef = useRef<string | null>(null);
  const isMultiDragRef = useRef(false);

  const handleCardDragStart = useCallback((id: string, _type: CardType) => {
    activeDragCardRef.current = id;
    if (selection.isSelected(id)) {
      isMultiDragRef.current = true;
    } else {
      selection.deselectAll();
      isMultiDragRef.current = false;
    }
  }, [selection]);

  const handleCardDragMove = useCallback((dx: number, dy: number) => {
    if (isMultiDragRef.current) {
      setMultiDragDelta({ dx, dy });
    }
    if (activeDragCardRef.current) {
      setLiveDragInfo({ cardId: activeDragCardRef.current, dx, dy });
    }
  }, []);

  const handleCardDragEnd = useCallback((dx: number, dy: number, didDrag: boolean) => {
    if (isMultiDragRef.current && didDrag) {
      const items = selection.selectedArray()
        .filter((s) => s.id !== activeDragCardRef.current);
      if (items.length > 0) {
        dispatch(moveCards({ items, dx, dy }));
      }
    }
    activeDragCardRef.current = null;
    isMultiDragRef.current = false;
    setMultiDragDelta(null);
    setLiveDragInfo(null);
  }, [selection, dispatch]);

  const handleCardSelect = useCallback((id: string, type: CardType, shiftKey: boolean) => {
    selection.selectCard(id, type, shiftKey);
  }, [selection]);

  const handleBringToFront = useCallback((id: string, type: CardType) => {
    dispatch(bringToFront({ id, type }));
  }, [dispatch]);

  // ---- Viewport event handlers (compose pan + marquee) ----
  const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      canvas.handlers.onMouseDown(e);
      return;
    }

    if (e.button === 2) {
      e.preventDefault();
      canvas.handlers.onMouseDown(e);
      return;
    }

    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;

    if (isElementSelectMode) {
      if (e.metaKey || e.ctrlKey) {
        canvas.handlers.onMouseDown(e);
      }
      return;
    }

    if (e.metaKey || e.ctrlKey || canvas.spaceHeld) {
      selection.deselectAll();
      canvas.handlers.onMouseDown(e);
    } else {
      selection.handleCanvasMouseDown(e.nativeEvent);
    }
  }, [canvas.handlers, canvas.spaceHeld, selection, isElementSelectMode]);

  const handleViewportMouseMove = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseMove(e);
    selection.handleCanvasMouseMove(e.nativeEvent);
  }, [canvas.handlers, selection]);

  const handleViewportMouseUp = useCallback((e: React.MouseEvent) => {
    canvas.handlers.onMouseUp();
    selection.handleCanvasMouseUp(e.nativeEvent);
  }, [canvas.handlers, selection]);

  useEffect(() => {
    if (!dashboardId) return;
    hasFittedRef.current = false;
    restoredExpandedRef.current = false;
    dispatch(resetLayout());
    dispatch(fetchSessions({ dashboardId }));
    dispatch(fetchHistory({ dashboardId }));
    dispatch(fetchLayout(dashboardId));
    dispatch(fetchOutputs());
    dashboardWs.connect();
    const cleanupBrowserHandler = initBrowserCommandHandler();
    return () => { cleanupBrowserHandler(); dashboardWs.disconnect(); };
  }, [dispatch, dashboardId]);

  const pendingBrowserUrl = useAppSelector((state) => state.tempState.pendingBrowserUrl);
  const pendingFocusAgentId = useAppSelector((state) => state.tempState.pendingFocusAgentId);

  useEffect(() => {
    if (!dashboardId) return;
    (window as any).__openswarm_last_dashboard_id = dashboardId;
  }, [dashboardId]);

  useEffect(() => {
    if (!pendingBrowserUrl || !layoutInitialized) return;
    dispatch(addBrowserCard({ url: pendingBrowserUrl, expandedSessionIds }));
    dispatch(clearPendingBrowserUrl());
  }, [pendingBrowserUrl, layoutInitialized, dispatch, expandedSessionIds]);

  // Capture a thumbnail screenshot of the dashboard.
  // Uses Electron's native capturePage for pixel-perfect results.
  // Captures current viewport as-is (no DOM mutation) to avoid visual flashes.
  // Re-captures when layout is saved (piggybacking on the save debounce).
  const pendingThumbnailRef = useRef<string | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureNow = useCallback(() => {
    const viewportEl = canvas.viewportRef.current;
    const contentEl = canvas.contentRef.current;
    if (!viewportEl || !contentEl) return;
    const layoutState = store.getState().dashboardLayout;
    const allCards = {
      cards: layoutState.cards,
      viewCards: layoutState.viewCards,
      browserCards: layoutState.browserCards,
    };
    const hasCards = Object.keys(allCards.cards).length > 0
      || Object.keys(allCards.viewCards).length > 0
      || Object.keys(allCards.browserCards).length > 0;
    if (!hasCards) return;
    captureDashboardThumbnail(viewportEl, contentEl, allCards)
      .then((thumbnail) => { if (thumbnail) pendingThumbnailRef.current = thumbnail; })
      .catch(() => {});
  }, [canvas.viewportRef, canvas.contentRef]);

  useEffect(() => {
    if (!dashboardId || !layoutInitialized) return;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, 2000);
    return () => { if (captureTimerRef.current) clearTimeout(captureTimerRef.current); };
  }, [dashboardId, layoutInitialized, captureNow]);

  // On exit, save the captured thumbnail to the backend
  useEffect(() => {
    if (!dashboardId) return;
    const exitingId = dashboardId;
    return () => {
      const thumbnail = pendingThumbnailRef.current;
      if (thumbnail) {
        store.dispatch(updateDashboardThumbnail({ id: exitingId, thumbnail }));
        pendingThumbnailRef.current = null;
      }
    };
  }, [dashboardId]);

  useEffect(() => {
    if (!layoutInitialized || hasFittedRef.current) return;
    if (pendingFocusAgentId) return;
    hasFittedRef.current = true;
    const timer = setTimeout(() => canvas.actions.fitToView(), 150);
    return () => clearTimeout(timer);
  }, [layoutInitialized, canvas.actions, pendingFocusAgentId]);

  useEffect(() => {
    if (!pendingFocusAgentId || !layoutInitialized) return;
    const agentId = pendingFocusAgentId;
    dispatch(clearPendingFocusAgentId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.cards[agentId];
      if (card) {
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
        handleHighlightCard(agentId);
      }
    }, 350);
  }, [pendingFocusAgentId, layoutInitialized, dispatch, canvas.actions, handleHighlightCard]);

  useEffect(() => {
    if (!layoutInitialized || restoredExpandedRef.current) return;
    restoredExpandedRef.current = true;
    dispatch(setExpandedSessionIds(persistedExpandedSessionIds));
  }, [layoutInitialized, persistedExpandedSessionIds, dispatch]);

  const prevSessionIdsRef = useRef<string>('');

  useEffect(() => {
    if (!layoutInitialized) return;
    const dashboardSessionIds = Object.values(sessions)
      .filter((s) => s.dashboard_id === dashboardId && s.mode !== 'browser-agent' && s.mode !== 'invoked-agent' && s.mode !== 'sub-agent')
      .map((s) => s.id);
    const liveIds = dashboardSessionIds.sort().join(',');
    if (liveIds === prevSessionIdsRef.current) return;
    prevSessionIdsRef.current = liveIds;
    dispatch(reconcileSessions({ sessionIds: dashboardSessionIds, expandedSessionIds }));
  }, [sessions, layoutInitialized, dispatch, dashboardId, expandedSessionIds]);

  // ---- Auto-reveal / collapse / unreveal sub-agent cards ----
  const autoRevealedRef = useRef(new Set<string>());
  const prevSubStatusRef = useRef<Record<string, string>>({});
  const prevParentStatusRef = useRef<Record<string, string>>({});

  useEffect(() => {
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

      dispatch(placeCard({ sessionId: sub.id, x: targetX, y: targetY, width: DEFAULT_CARD_W, height: DEFAULT_CARD_H }));
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
  }, [sessions, cards, layoutInitialized, autoRevealSubAgents, dispatch]);

  const skipInitialSave = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Parameters<typeof saveLayout>[0] | null>(null);

  useEffect(() => {
    if (!layoutInitialized || !dashboardId) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    const payload = { dashboardId, cards, viewCards, browserCards, expandedSessionIds };
    pendingSaveRef.current = payload;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      dispatch(saveLayout(payload));
      pendingSaveRef.current = null;
      saveTimerRef.current = null;
      captureNow();
    }, 500);
  }, [cards, viewCards, browserCards, expandedSessionIds, layoutInitialized, dashboardId, dispatch, captureNow]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (pendingSaveRef.current) {
        dispatch(saveLayout(pendingSaveRef.current));
        pendingSaveRef.current = null;
      }
    };
  }, [dispatch]);

  useEffect(() => {
    const parts = newAgentShortcut.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needsMeta = parts.includes('meta');
    const needsCtrl = parts.includes('ctrl');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');

    const handleShortcut = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return;
      if (needsMeta !== e.metaKey) return;
      if (needsCtrl !== e.ctrlKey) return;
      if (needsShift !== e.shiftKey) return;
      if (needsAlt !== e.altKey) return;
      e.preventDefault();
      setToolbarOpen(true);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [newAgentShortcut]);

  useEffect(() => {
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selection.selectedIds.size !== 1) return;
      const [id, type] = selection.selectedIds.entries().next().value!;
      if (type !== 'agent') return;
      e.preventDefault();
      dispatch(toggleExpandSession(id));
    };
    window.addEventListener('keydown', handleEnter);
    return () => window.removeEventListener('keydown', handleEnter);
  }, [selection.selectedIds, dispatch]);

  useEffect(() => {
    const handleDelete = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selection.selectedIds.size === 0) return;
      e.preventDefault();
      for (const [id, type] of selection.selectedIds) {
        if (type === 'agent') {
          dispatch(closeSession({ sessionId: id }));
        } else if (type === 'view') {
          dispatch(removeViewCard(id));
        } else if (type === 'browser') {
          dispatch(removeBrowserCard(id));
        }
      }
      selection.deselectAll();
    };
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [selection, dispatch]);

  useEffect(() => {
    const handleCopy = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (selection.selectedIds.size === 0) return;

      e.preventDefault();
      const copied: ClipboardCard[] = [];
      const names: string[] = [];
      for (const [id, type] of selection.selectedIds) {
        if (type === 'agent') {
          const session = sessions[id];
          const card = cards[id];
          if (!session || !card) continue;
          copied.push({
            type, id, name: session.name || id,
            meta: { name: session.name, status: session.status, model: session.model, mode: session.mode },
            x: card.x, y: card.y, width: card.width, height: card.height,
            expanded: expandedSessionIds.includes(id),
          });
          names.push(session.name || id);
        } else if (type === 'view') {
          const output = outputs[id];
          const vc = viewCards[id];
          if (!output || !vc) continue;
          copied.push({
            type, id, name: output.name,
            meta: { name: output.name, description: output.description },
            x: vc.x, y: vc.y, width: vc.width, height: vc.height,
          });
          names.push(output.name);
        } else if (type === 'browser') {
          const bc = browserCards[id];
          if (!bc) continue;
          const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId);
          const title = activeTab?.title || 'Browser';
          copied.push({
            type, id, name: title,
            meta: { name: title, url: activeTab?.url || bc.url, tabs: bc.tabs },
            x: bc.x, y: bc.y, width: bc.width, height: bc.height,
          });
          names.push(title);
        }
      }
      setClipboardCards(copied);
      navigator.clipboard.writeText(names.join(', ')).catch(() => {});
    };
    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
  }, [selection.selectedIds, sessions, cards, viewCards, browserCards, outputs, expandedSessionIds]);

  useEffect(() => {
    const PASTE_OFFSET = 40;
    const handlePaste = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'v') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      const copied = getClipboardCards();
      if (copied.length === 0) return;
      e.preventDefault();

      selection.deselectAll();
      const newSelection = new Map<string, CardType>();

      for (const card of copied) {
        const px = card.x + PASTE_OFFSET;
        const py = card.y - PASTE_OFFSET;

        if (card.type === 'agent') {
          const action = await dispatch(duplicateSession({ sessionId: card.id, dashboardId }));
          if (duplicateSession.fulfilled.match(action)) {
            const newId = action.payload.id;
            dispatch(placeCard({ sessionId: newId, x: px, y: py, width: card.width, height: card.height }));
            if (card.expanded) {
              dispatch(expandSession(newId));
            }
            newSelection.set(newId, 'agent');
          }
        } else if (card.type === 'view') {
          dispatch(addViewCard({ outputId: card.id, expandedSessionIds, x: px, y: py, width: card.width, height: card.height }));
          newSelection.set(card.id, 'view');
        } else if (card.type === 'browser') {
          const browserId = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          dispatch(pasteBrowserCard({
            id: browserId, tabs: card.meta.tabs || [], url: card.meta.url || '',
            x: px, y: py, width: card.width, height: card.height,
          }));
          newSelection.set(browserId, 'browser');
        }
      }

      if (newSelection.size > 0) {
        for (const [id, type] of newSelection) {
          selection.selectCard(id, type, true);
        }
      }
    };
    window.addEventListener('keydown', handlePaste);
    return () => window.removeEventListener('keydown', handlePaste);
  }, [dispatch, dashboardId, expandedSessionIds, selection]);

  const handleBranchFromCard = useCallback(
    (sourceSessionId: string, newSessionId: string) => {
      const sourceCard = cards[sourceSessionId];
      if (!sourceCard) return;

      const targetX = sourceCard.x + sourceCard.width + GRID_GAP * 12;
      let targetY = sourceCard.y;

      const columnCards = Object.values(cards).filter(
        (c) => Math.abs(c.x - targetX) < 50 && c.session_id !== newSessionId,
      );
      if (columnCards.length > 0) {
        const lowestBottom = Math.max(
          ...columnCards.map((c) => c.y + Math.max(EXPANDED_CARD_MIN_H, c.height)),
        );
        targetY = lowestBottom + GRID_GAP;
      }

      spawnOriginsRef.current[newSessionId] = {
        x: sourceCard.x,
        y: sourceCard.y,
        type: 'branch' as const,
      };

      dispatch(placeCard({
        sessionId: newSessionId,
        x: targetX,
        y: targetY,
        width: DEFAULT_CARD_W,
        height: DEFAULT_CARD_H,
      }));

      if (expandedSessionIds.includes(sourceSessionId)) {
        dispatch(expandSession(newSessionId));
      }

      dispatch(setGlowingAgentCard({ sessionId: newSessionId, sourceId: sourceSessionId, label: 'Branch' }));
    },
    [cards, dispatch, expandedSessionIds],
  );

  const handleNewAgent = useCallback(() => {
    setToolbarOpen(true);
  }, []);

  const handleToolbarCancel = useCallback(() => {
    setToolbarOpen(false);
  }, []);

  const handleToolbarSend = useCallback(
    (
      prompt: string,
      mode: string,
      model: string,
      images?: Array<{ data: string; media_type: string }>,
      contextPaths?: ContextPath[],
      forcedTools?: string[],
      attachedSkills?: Array<{ id: string; name: string; content: string }>,
      selectedBrowserIds?: string[],
    ) => {
      setToolbarOpen(false);

      const draftId = `draft-${Date.now().toString(36)}`;

      const toolbarEl = toolbarRef.current;
      const vpEl = canvas.viewportRef.current;
      if (toolbarEl && vpEl) {
        const tr = toolbarEl.getBoundingClientRect();
        const vr = vpEl.getBoundingClientRect();
        const toolbarCenterX = tr.left + tr.width / 2;
        const toolbarTopY = tr.top;
        const { panX, panY, zoom } = canvasStateRef.current;
        spawnOriginsRef.current[draftId] = {
          x: (toolbarCenterX - vr.left - panX) / zoom,
          y: (toolbarTopY - vr.top - panY) / zoom,
        };
      }

      const config: AgentConfig = { name: 'New chat', model, mode, dashboard_id: dashboardId };

      dispatch(
        launchAndSendFirstMessage({
          draftId,
          config,
          prompt,
          mode,
          model,
          images,
          contextPaths: contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })),
          forcedTools,
          attachedSkills,
          expand: expandNewChats,
        }),
      ).then((action) => {
        if (launchAndSendFirstMessage.fulfilled.match(action)) {
          const realId = action.payload.session.id;
          dispatch(generateTitle({ sessionId: realId, prompt }));
          if (selectedBrowserIds?.length) {
            dispatch(setGlowingBrowserCards({ browserIds: selectedBrowserIds, sessionId: realId, label: 'Use Browser' }));

            if (selectedBrowserIds.length === 1) {
              const bc = store.getState().dashboardLayout.browserCards[selectedBrowserIds[0]];
              if (bc) {
                dispatch(setCardPosition({
                  sessionId: realId,
                  x: bc.x - DEFAULT_CARD_W - GRID_GAP * 12,
                  y: bc.y,
                }));
              }
            }
          }
          spawnOriginsRef.current[realId] = spawnOriginsRef.current[draftId];
          delete spawnOriginsRef.current[draftId];

          if (expandNewChats) {
            setAutoFocusSessionId(realId);
          } else {
            setPendingSelectSessionId(realId);
          }

          setTimeout(() => {
            const card = store.getState().dashboardLayout.cards[realId];
            if (card) {
              const isExp = store.getState().agents.expandedSessionIds.includes(realId);
              const height = isExp ? Math.max(EXPANDED_CARD_MIN_H, card.height) : card.height;
              canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height }], 1.0, true);
              handleHighlightCard(realId);
            }
          }, 200);

          if (dashboardId) {
            const currentSessions = store.getState().agents.sessions;
            const agentCount = Object.values(currentSessions).filter(
              (s) => s.status !== 'draft' && s.dashboard_id === dashboardId,
            ).length;
            const NAME_GEN_TRIGGERS = [1, 3, 6];
            const currentDash = store.getState().dashboards.items[dashboardId];
            const canAutoName =
              currentDash &&
              (currentDash.auto_named || currentDash.name === 'Untitled Dashboard');

            if (NAME_GEN_TRIGGERS.includes(agentCount) && canAutoName) {
              dispatch(generateDashboardName(dashboardId));
            }
          }
        } else {
          delete spawnOriginsRef.current[draftId];
        }
      });
    },
    [canvas.viewportRef, canvas.actions, dispatch, dashboardId, expandNewChats, handleHighlightCard],
  );

  const handleAddView = useCallback((outputId: string) => {
    dispatch(addViewCard({ outputId, expandedSessionIds }));
    setTimeout(() => {
      const card = store.getState().dashboardLayout.viewCards[outputId];
      if (card) {
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
        handleHighlightCard(outputId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvas.actions, handleHighlightCard]);

  const handleAddBrowser = useCallback(() => {
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.browserCards));
    dispatch(addBrowserCard({ url: browserHomepage, expandedSessionIds }));
    setTimeout(() => {
      const allBrowserCards = store.getState().dashboardLayout.browserCards;
      const newId = Object.keys(allBrowserCards).find((id) => !prevIds.has(id));
      if (newId) {
        const card = allBrowserCards[newId];
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, browserHomepage, expandedSessionIds, canvas.actions, handleHighlightCard]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(resumeSession({ sessionId })).then((action) => {
      if (resumeSession.fulfilled.match(action)) {
        dispatch(expandSession(sessionId));
        setAutoFocusSessionId(sessionId);
        setTimeout(() => {
          const card = store.getState().dashboardLayout.cards[sessionId];
          if (card) {
            canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.0, true);
            handleHighlightCard(sessionId);
          }
        }, 200);
      }
    });
  }, [dispatch, canvas.actions, handleHighlightCard, setAutoFocusSessionId]);

  const handleTidy = useCallback(() => {
    const currentExpanded = store.getState().agents.expandedSessionIds;
    dispatch(tidyLayout({ expandedSessionIds: currentExpanded }));

    const expandedSet = new Set(currentExpanded);
    const { cards: tidied, viewCards: tidiedViews, browserCards: tidiedBrowsers } = store.getState().dashboardLayout;
    const allRects = [
      ...Object.values(tidied).map((c) => ({
        x: c.x, y: c.y, width: c.width,
        height: expandedSet.has(c.session_id) ? Math.max(EXPANDED_CARD_MIN_H, c.height) : c.height,
      })),
      ...Object.values(tidiedViews).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      ...Object.values(tidiedBrowsers).map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
    ];
    canvas.actions.fitToCards(allRects);
  }, [dispatch, canvas.actions]);

  useEffect(() => {
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
          : (measuredHeightsRef.current[id] ?? card.height);
        cursor += h + GRID_GAP * 2;
      }
    }
  // measuredHeightsTick in deps ensures we re-run once ResizeObserver reports
  // the new height after a collapse (avoids stale-height no-ops)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedSessionIds, glowingAgentCards, cards, dispatch, measuredHeightsTick]);

  useEffect(() => {
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
  }, [glowingBrowserCards, browserCards, cards, dispatch]);

  const TETHER_FADE_MS = 2500;

  const tethers = useMemo(() => {
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

    const agentTethers = Object.entries(glowingAgentCards).map(([copyId, { sourceId, fading, sourceYRatio, label }]) => {
      const src = cards[sourceId];
      const dst = cards[copyId];
      if (!src || !dst) return null;

      let srcX = src.x, srcY = src.y;
      let dstX = dst.x, dstY = dst.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === copyId) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }

      const srcMeasured = measuredHeightsRef.current[sourceId];
      const srcH = srcMeasured ?? (expandedSessionIds.includes(sourceId)
        ? Math.max(EXPANDED_CARD_MIN_H, src.height)
        : src.height);
      const dstMeasured = measuredHeightsRef.current[copyId];
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
    }).filter(Boolean) as Array<{ key: string; path: string; labelX: number; labelY: number; label: string; fading: boolean }>;

    const browserTethers = Object.entries(glowingBrowserCards).map(([browserId, { sourceId, fading, label }]) => {
      const src = cards[sourceId];
      const dst = browserCards[browserId];
      if (!src || !dst) return null;

      let srcX = src.x, srcY = src.y;
      let dstX = dst.x, dstY = dst.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === browserId) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }

      const srcMeasured = measuredHeightsRef.current[sourceId];
      const srcH = srcMeasured ?? (expandedSessionIds.includes(sourceId)
        ? Math.max(EXPANDED_CARD_MIN_H, src.height)
        : src.height);
      const dstH = dst.height;

      const srcCx = srcX + src.width / 2;
      const dstCx = dstX + dst.width / 2;

      type Anchor = { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' };
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
        label: label || '',
        fading,
      };
    }).filter(Boolean) as Array<{ key: string; path: string; labelX: number; labelY: number; label: string; fading: boolean }>;

    return [...agentTethers, ...browserTethers];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowingAgentCards, glowingBrowserCards, cards, browserCards, expandedSessionIds, liveDragInfo, measuredHeightsTick]);

  const dotSize = Math.max(1, 1.5 * canvas.zoom);
  const dotSpacing = 24 * canvas.zoom;

  return (
    <>
    <DashboardSelectionOverlay />
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {/* Floating header overlay */}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          pointerEvents: 'none',
          p: 3,
          pb: 0,
          background: `linear-gradient(to bottom, ${c.bg.page} 60%, transparent)`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
          <DashboardHeader
            dashboardName={dashboardName}
            sessions={sessions}
            cards={cards}
            viewCards={viewCards}
            browserCards={browserCards}
            outputs={outputs}
            dashboardId={dashboardId}
            canvasActions={canvas.actions}
            onHighlightCard={handleHighlightCard}
          />
        </Box>
      </Box>

      {/* Canvas viewport */}
      <Box
        ref={canvas.viewportRef}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onContextMenu={(e) => e.preventDefault()}
        sx={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor: canvas.isPanning
            ? 'grabbing'
            : (canvas.spaceHeld || canvas.cmdHeld)
              ? 'grab'
              : selection.marquee
                ? 'crosshair'
                : 'default',
        }}
      >
        {/* Dot grid background */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `radial-gradient(circle, ${c.border.medium} ${dotSize}px, transparent ${dotSize}px)`,
            backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
            backgroundPosition: `${canvas.panX % dotSpacing}px ${canvas.panY % dotSpacing}px`,
          }}
        />

        {sessionList.length === 0 && Object.keys(viewCards).length === 0 && Object.keys(browserCards).length === 0 ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
              No agents running
            </Typography>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.9rem' }}>
              Click &quot;New Agent&quot; to launch your first Claude Code instance
            </Typography>
          </Box>
        ) : (
          <div
            ref={canvas.contentRef}
            style={{
              transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
              position: 'relative',
            }}
          >
            {/* Tether lines between branched cards */}
            {tethers.length > 0 && (
              <svg
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 1,
                  height: 1,
                  overflow: 'visible',
                  pointerEvents: 'none',
                  zIndex: 10,
                }}
              >
                <defs>
                  <filter id="tether-glow-f" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <marker
                    id="tether-arrow"
                    viewBox="0 0 10 10"
                    refX="10"
                    refY="5"
                    markerWidth="10"
                    markerHeight="10"
                    orient="auto"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill={c.accent.primary} opacity={0.8} />
                  </marker>
                </defs>
                <style>{`
                  @keyframes tether-flow { to { stroke-dashoffset: -16; } }
                  @keyframes tether-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
                `}</style>
                {tethers.map((t) => (
                  <g
                    key={t.key}
                    style={{
                      opacity: t.fading ? 0 : 1,
                      transition: `opacity ${TETHER_FADE_MS}ms ease-out`,
                    }}
                  >
                    <path
                      d={t.path}
                      fill="none"
                      stroke={c.accent.primary}
                      strokeWidth={8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.2}
                      filter="url(#tether-glow-f)"
                    />
                    <path
                      d={t.path}
                      fill="none"
                      stroke={c.accent.primary}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.65}
                      markerEnd="url(#tether-arrow)"
                      style={{ animation: 'tether-pulse 2s ease-in-out infinite' }}
                    />
                    <path
                      d={t.path}
                      fill="none"
                      stroke={c.accent.primary}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray="8 8"
                      opacity={0.9}
                      style={{ animation: 'tether-flow 0.6s linear infinite' }}
                    />
                    {t.label && (
                      <g transform={`translate(${t.labelX},${t.labelY})`}>
                        <rect
                          x={-4}
                          y={-14}
                          width={t.label.length * 7.5 + 8}
                          height={20}
                          rx={4}
                          fill={c.bg.surface}
                          stroke={c.accent.primary}
                          strokeWidth={1}
                          opacity={0.95}
                        />
                        <text
                          x={t.label.length * 7.5 / 2}
                          y={1}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight={600}
                          fontFamily="inherit"
                          fill={c.accent.primary}
                        >
                          {t.label}
                        </text>
                      </g>
                    )}
                  </g>
                ))}
              </svg>
            )}
            <AnimatePresence>
            {Object.values(cards).map((card) => {
              const session = sessions[card.session_id];
              if (!session) return null;

              let origin = spawnOriginsRef.current[session.id];
              if (origin) {
                delete spawnOriginsRef.current[session.id];
              } else {
                const glow = glowingAgentCards[session.id];
                if (glow && !revealSpawnedRef.current.has(session.id)) {
                  revealSpawnedRef.current.add(session.id);
                  const srcCard = cards[glow.sourceId];
                  if (srcCard) {
                    const srcH = measuredHeightsRef.current[glow.sourceId]
                      ?? (expandedSessionIds.includes(glow.sourceId)
                        ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height)
                        : srcCard.height);
                    origin = {
                      x: srcCard.x + srcCard.width,
                      y: srcCard.y + srcH / 2,
                      type: 'branch' as const,
                    };
                  }
                }
              }

              let exitTarget: { x: number; y: number } | undefined;
              const glow = glowingAgentCards[session.id];
              if (glow) {
                const srcCard = cards[glow.sourceId];
                if (srcCard) {
                  const srcH = measuredHeightsRef.current[glow.sourceId]
                    ?? (expandedSessionIds.includes(glow.sourceId)
                      ? Math.max(EXPANDED_CARD_MIN_H, srcCard.height)
                      : srcCard.height);
                  exitTarget = {
                    x: srcCard.x + srcCard.width,
                    y: srcCard.y + srcH / 2,
                  };
                }
              }

              let snapColumn: { x: number; width: number } | undefined;
              if (glow) {
                const srcCard = cards[glow.sourceId];
                if (srcCard) {
                  snapColumn = {
                    x: srcCard.x + srcCard.width + GRID_GAP * 12,
                    width: DEFAULT_CARD_W,
                  };
                }
              }

              return (
                <AgentCard
                  key={session.id}
                  session={session}
                  expanded={expandedSessionIds.includes(session.id)}
                  cardX={card.x}
                  cardY={card.y}
                  cardWidth={card.width}
                  cardHeight={card.height}
                  cardZOrder={card.zOrder ?? 0}
                  zoom={canvas.zoom}
                  spawnFrom={origin}
                  exitTarget={exitTarget}
                  isSelected={selection.isSelected(session.id)}
                  isHighlighted={highlightedCardId === session.id}
                  multiDragDelta={multiDragDelta}
                  onCardSelect={handleCardSelect}
                  onDragStart={handleCardDragStart}
                  onDragMove={handleCardDragMove}
                  onDragEnd={handleCardDragEnd}
                  onBranch={handleBranchFromCard}
                  onMeasuredHeight={handleMeasuredHeight}
                  snapColumn={snapColumn}
                  autoFocusInput={autoFocusSessionId === session.id}
                  onBringToFront={handleBringToFront}
                />
              );
            })}
            </AnimatePresence>
            {Object.values(viewCards).map((vc) => {
              const output = outputs[vc.output_id];
              if (!output) return null;
              return (
                <DashboardViewCard
                  key={`view-${vc.output_id}`}
                  output={output}
                  cardX={vc.x}
                  cardY={vc.y}
                  cardWidth={vc.width}
                  cardHeight={vc.height}
                  cardZOrder={vc.zOrder ?? 0}
                  zoom={canvas.zoom}
                  cmdHeld={canvas.cmdHeld}
                  isSelected={selection.isSelected(vc.output_id)}
                  isHighlighted={highlightedCardId === vc.output_id}
                  multiDragDelta={multiDragDelta}
                  onCardSelect={handleCardSelect}
                  onDragStart={handleCardDragStart}
                  onDragMove={handleCardDragMove}
                  onDragEnd={handleCardDragEnd}
                  onBringToFront={handleBringToFront}
                />
              );
            })}
            {Object.values(browserCards).map((bc) => (
              <BrowserCard
                key={`browser-${bc.browser_id}`}
                browserId={bc.browser_id}
                tabs={bc.tabs}
                activeTabId={bc.activeTabId}
                cardX={bc.x}
                cardY={bc.y}
                cardWidth={bc.width}
                cardHeight={bc.height}
                cardZOrder={bc.zOrder ?? 0}
                zoom={canvas.zoom}
                cmdHeld={canvas.cmdHeld}
                isSelected={selection.isSelected(bc.browser_id)}
                isHighlighted={highlightedCardId === bc.browser_id}
                multiDragDelta={multiDragDelta}
                onCardSelect={handleCardSelect}
                onDragStart={handleCardDragStart}
                onDragMove={handleCardDragMove}
                onDragEnd={handleCardDragEnd}
                onBringToFront={handleBringToFront}
              />
            ))}
            {/* Marquee selection rectangle */}
            {selection.marquee && (
              <div
                style={{
                  position: 'absolute',
                  left: selection.marquee.x,
                  top: selection.marquee.y,
                  width: selection.marquee.width,
                  height: selection.marquee.height,
                  border: '1.5px dashed rgba(59, 130, 246, 0.6)',
                  background: 'rgba(59, 130, 246, 0.08)',
                  borderRadius: 2,
                  pointerEvents: 'none',
                  zIndex: 9999,
                }}
              />
            )}
          </div>
        )}
      </Box>

      {/* Floating bottom toolbar */}
      <Box sx={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <DashboardToolbar
          ref={toolbarRef}
          inputOpen={toolbarOpen}
          onNewAgent={handleNewAgent}
          onCancel={handleToolbarCancel}
          onSend={handleToolbarSend}
          onAddView={handleAddView}
          onHistoryResume={handleHistoryResume}
          onAddBrowser={handleAddBrowser}
          dashboardId={dashboardId}
        />
      </Box>

      {/* Floating zoom controls */}
      <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
        <CanvasControls zoom={canvas.zoom} actions={canvas.actions} onTidy={handleTidy} />
      </Box>
    </Box>
    </>
  );
};

const Dashboard: React.FC = () => (
  <ElementSelectionProvider>
    <DashboardInner />
  </ElementSelectionProvider>
);

export default Dashboard;
