import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DashboardHeader from './DashboardHeader';
import { report } from '@/shared/serviceClient';
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
  removeWorkflowCard,
  pasteBrowserCard,
  placeCard,
  setCardPosition,
  removeCard,
  bringToFront,
  setGlowingAgentCard,
  clearGlowingAgentCard,
  clearPendingFocusBrowserId,
  clearPendingFocusWorkflowId,
  clearPendingFocusWorkflowsHub,
  addNote,
  removeNote,
  clearPendingFocusNoteId,
  DEFAULT_CARD_W,
  DEFAULT_CARD_H,
  EXPANDED_CARD_MIN_H,
  GRID_GAP,
} from '@/shared/state/dashboardLayoutSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { fetchWorkflows, closeWorkflowCard } from '@/shared/state/workflowsSlice';
import { generateDashboardName, updateDashboardThumbnail } from '@/shared/state/dashboardsSlice';
import { dashboardWs } from '@/shared/ws/WebSocketManager';
import { initBrowserCommandHandler } from '@/shared/browserCommandHandler';
import { clearPendingBrowserUrl, clearPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import AgentCard from './AgentCard';
import DashboardViewCard from './DashboardViewCard';
import BrowserCard from './BrowserCard';
import NoteCard from './NoteCard';
import CanvasControls from './CanvasControls';
import CardSearchPalette from './CardSearchPalette';
import DirectionHints from './DirectionHints';
import DashboardToolbar from './DashboardToolbar';
import WorkflowCard from '@/app/pages/Workflows/WorkflowCard';
import WorkflowsHubCard from '@/app/pages/Workflows/WorkflowsHubCard';
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
import { API_BASE } from '@/shared/config';

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

interface DashboardProps {
  dashboardId: string;
  isActive?: boolean;
}

const DashboardInner: React.FC<DashboardProps> = ({ dashboardId, isActive = true }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
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
  const workflowCards = useAppSelector((state) => state.dashboardLayout.workflowCards);
  const workflowItems = useAppSelector((state) => state.workflows.items);
  const workflowOpenCards = useAppSelector((state) => state.workflows.openCards);
  const workflowsHub = useAppSelector((state) => state.dashboardLayout.workflowsHub);
  const notes = useAppSelector((state) => state.dashboardLayout.notes);
  const pendingFocusNoteId = useAppSelector((state) => state.dashboardLayout.pendingFocusNoteId);
  const layoutInitialized = useAppSelector((state) => state.dashboardLayout.initialized);
  const persistedExpandedSessionIds = useAppSelector((state) => state.dashboardLayout.persistedExpandedSessionIds);
  const zoomSensitivity = useAppSelector((state) => state.settings.data.zoom_sensitivity);
  const newAgentShortcut = useAppSelector((state) => state.settings.data.new_agent_shortcut);
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const expandNewChats = useAppSelector((state) => state.settings.data.expand_new_chats_in_dashboard);
  const autoRevealSubAgents = useAppSelector((state) => state.settings.data.auto_reveal_sub_agents);
  const outputs = useAppSelector((state) => state.outputs.items);
  const outputsLoaded = useAppSelector((state) => state.outputs.loaded);
  const glowingAgentCards = useAppSelector((state) => state.dashboardLayout.glowingAgentCards);
  const glowingBrowserCards = useAppSelector((state) => state.dashboardLayout.glowingBrowserCards);
  // Memo on sessions identity; RTK only swaps the dict ref when a value changes, so sessionList stays stable.
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);

  const contentBounds = useMemo(() => {
    const allRects = [
      ...Object.values(cards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(viewCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(browserCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
      ...Object.values(workflowCards).map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
      ...(workflowsHub ? [{ x: workflowsHub.x, y: workflowsHub.y, w: workflowsHub.width, h: workflowsHub.height }] : []),
    ];
    if (allRects.length === 0) return undefined;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of allRects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    return { minX, minY, maxX, maxY };
  }, [cards, viewCards, browserCards, workflowCards, workflowsHub]);

  const canvas = useCanvasControls(zoomSensitivity, contentBounds, isActive);
  const selection = useDashboardSelection(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, viewportRef: canvas.viewportRef },
    cards,
    viewCards,
    browserCards,
    notes,
    workflowCards,
  );
  const toolbarRef = useRef<HTMLDivElement>(null);

  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoFocusSessionId, setAutoFocusSessionId] = useState<string | null>(null);
  const [pendingSelectSessionId, setPendingSelectSessionId] = useState<string | null>(null);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [newAgentBounce, setNewAgentBounce] = useState(false);
  // Wipe leftover v1 walkthrough localStorage; v2 ignores it but it would persist forever.
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
  // Stable getter so AgentCards read pan/zoom on demand during drag math.
  const getCanvasState = useCallback(() => canvasStateRef.current, []);
  // Effect (not render-body) fires the pan-changed event so dragging cards re-pin to cursor; safe in strict mode.
  useEffect(() => {
    window.dispatchEvent(new Event('openswarm:canvas-pan-changed'));
  }, [canvas.panX, canvas.panY, canvas.zoom]);

  const EDGE_ZONE = 60;
  const EDGE_MAX_SPEED = 8;
  const edgePanFrameRef = useRef<number | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Track pan at drag start so cards can compensate for edge-pan offset.
  const dragStartPanRef = useRef<{ panX: number; panY: number }>({ panX: 0, panY: 0 });

  const stopEdgePan = useCallback(() => {
    if (edgePanFrameRef.current) {
      cancelAnimationFrame(edgePanFrameRef.current);
      edgePanFrameRef.current = null;
    }
  }, []);

  const tickEdgePan = useCallback(() => {
    const vp = canvas.viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const { x: mx, y: my } = lastMousePosRef.current;

    let dx = 0;
    let dy = 0;

    if (mx < rect.left + EDGE_ZONE) {
      dx = EDGE_MAX_SPEED * ((rect.left + EDGE_ZONE - mx) / EDGE_ZONE);
    } else if (mx > rect.right - EDGE_ZONE) {
      dx = -EDGE_MAX_SPEED * ((mx - (rect.right - EDGE_ZONE)) / EDGE_ZONE);
    }
    if (my < rect.top + EDGE_ZONE) {
      dy = EDGE_MAX_SPEED * ((rect.top + EDGE_ZONE - my) / EDGE_ZONE);
    } else if (my > rect.bottom - EDGE_ZONE) {
      dy = -EDGE_MAX_SPEED * ((my - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
    }

    if (dx !== 0 || dy !== 0) {
      canvas.actions.setState((prev: { panX: number; panY: number; zoom: number }) => ({
        ...prev,
        panX: prev.panX + dx,
        panY: prev.panY + dy,
      }));
    }

    edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
  }, [canvas.viewportRef, canvas.actions]);

  const [multiDragDelta, setMultiDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<{ cardId: string; dx: number; dy: number } | null>(null);
  const activeDragCardRef = useRef<string | null>(null);
  const isMultiDragRef = useRef(false);

  const edgePanStartedRef = useRef(false);

  const handleCardDragStart = useCallback((id: string, _type: CardType) => {
    activeDragCardRef.current = id;
    edgePanStartedRef.current = false;
    if (selection.isSelected(id)) {
      isMultiDragRef.current = true;
    } else {
      selection.deselectAll();
      isMultiDragRef.current = false;
    }
  }, [selection]);

  const handleCardDragMove = useCallback((dx: number, dy: number, mouseX?: number, mouseY?: number) => {
    if (mouseX !== undefined && mouseY !== undefined) {
      lastMousePosRef.current = { x: mouseX, y: mouseY };
    }
    if (!edgePanStartedRef.current) {
      edgePanStartedRef.current = true;
      edgePanFrameRef.current = requestAnimationFrame(tickEdgePan);
    }
    if (isMultiDragRef.current) {
      setMultiDragDelta({ dx, dy });
    }
    if (activeDragCardRef.current) {
      setLiveDragInfo({ cardId: activeDragCardRef.current, dx, dy });
    }
  }, [tickEdgePan]);

  const handleCardDragEnd = useCallback((dx: number, dy: number, didDrag: boolean) => {
    if (didDrag) report('dashboard', 'card_dragged');
    stopEdgePan();
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
  }, [selection, dispatch, stopEdgePan]);

  const getCardRect = useCallback((id: string, type: CardType) => {
    const layoutState = store.getState().dashboardLayout;
    if (type === 'agent') {
      const card = layoutState.cards[id];
      if (!card) return undefined;
      return { x: card.x, y: card.y, width: card.width, height: card.height };
    } else if (type === 'view') {
      const vc = layoutState.viewCards[id];
      if (!vc) return undefined;
      return { x: vc.x, y: vc.y, width: vc.width, height: vc.height };
    } else if (type === 'browser') {
      const bc = layoutState.browserCards[id];
      if (!bc) return undefined;
      return { x: bc.x, y: bc.y, width: bc.width, height: bc.height };
    } else if (type === 'note') {
      const n = layoutState.notes[id];
      if (!n) return undefined;
      return { x: n.x, y: n.y, width: n.width, height: n.height };
    } else if (type === 'workflow') {
      const wc = layoutState.workflowCards[id];
      if (!wc) return undefined;
      return { x: wc.x, y: wc.y, width: wc.width, height: wc.height };
    }
    return undefined;
  }, []);

  // Delay single-click collapse so double-click can override.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCardSelect = useCallback((id: string, type: CardType, shiftKey: boolean) => {
    report('dashboard', 'card_clicked', { card_type: type, shift: shiftKey });
    if (shiftKey) {
      selection.selectCard(id, type, true);
      return;
    }

    selection.selectCard(id, type, false);
    dispatch(bringToFront({ id, type }));

    const alreadyExpanded = type === 'agent' && expandedSessionIds.includes(id);

    if (alreadyExpanded) {
      // Double-click handler clears this timer to override the single-click collapse.
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        dispatch(collapseSession(id));
      }, 250);
      return;
    }

    if (type === 'agent') {
      dispatch(expandSession(id));
    }
    setFocusedCardId(id);
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true, type === 'browser' ? 0.8 : undefined);
      setTimeout(() => (document.activeElement as HTMLElement)?.blur?.(), 150);
    }, 100);
  }, [selection, getCardRect, canvas.actions, dispatch, expandedSessionIds]);

  const handleBringToFront = useCallback((id: string, type: CardType) => {
    dispatch(bringToFront({ id, type }));
  }, [dispatch]);

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

    // Drop lingering input focus so arrow-key nav works immediately.
    const active = document.activeElement as HTMLElement | null;
    const activeTag = active?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || (active as any)?.isContentEditable) {
      active?.blur?.();
    }

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

  const handleViewportDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;
    report('dashboard', 'canvas_double_clicked');
    canvas.actions.fitToView();
  }, [canvas.actions]);

  const handleCardDoubleClick = useCallback((id: string, type: CardType) => {
    report('dashboard', 'card_double_clicked', { card_type: type });
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (type === 'agent') {
      dispatch(expandSession(id));
    }
    dispatch(bringToFront({ id, type }));
    setFocusedCardId(id);
    setTimeout(() => {
      const rect = getCardRect(id, type);
      if (rect) canvas.actions.fitToCards([rect], 1.15, true);
      setTimeout(() => (document.activeElement as HTMLElement)?.blur?.(), 150);
    }, 100);
  }, [getCardRect, canvas.actions, dispatch]);

  useEffect(() => {
    if (!dashboardId) return;
    const startTime = Date.now();
    report('dashboard', 'opened', { dashboard_id: dashboardId });
    return () => {
      report('dashboard', 'closed', {
        dashboard_id: dashboardId,
        time_spent_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    };
  }, [dashboardId]);

  useEffect(() => {
    if (!dashboardId) return;
    hasFittedRef.current = false;
    restoredExpandedRef.current = false;
    dispatch(resetLayout());
    // First-paint critical: do not defer.
    dispatch(fetchSessions({ dashboardId }));
    dispatch(fetchLayout(dashboardId));
    const cleanupBrowserHandler = initBrowserCommandHandler();
    // Deferred: history, outputs, and dashboard WS are off the first-paint path; post-paint scheduling improves LCP.
    const idleHandle = (typeof window !== 'undefined' && (window as any).requestIdleCallback)
      ? (window as any).requestIdleCallback(() => {
          dispatch(fetchHistory({ dashboardId }));
          dispatch(fetchOutputs());
          dispatch(fetchWorkflows(dashboardId));
          dashboardWs.connect();
        }, { timeout: 2000 })
      : window.setTimeout(() => {
          dispatch(fetchHistory({ dashboardId }));
          dispatch(fetchOutputs());
          dispatch(fetchWorkflows(dashboardId));
          dashboardWs.connect();
        }, 200);

    // Pre-warm Anthropic prompt cache ~250ms after mount so first message hits a warm cache; backend skips non-Anthropic sessions.
    const warmAbort = new AbortController();
    const warmTimer = setTimeout(async () => {
      try {
        const sessionsState = store.getState().agents.sessions;
        const dashSessions = Object.values(sessionsState).filter(
          (s) => s.dashboard_id === dashboardId &&
                 s.status !== 'draft' &&
                 s.mode !== 'browser-agent' &&
                 s.mode !== 'sub-agent' &&
                 s.mode !== 'invoked-agent',
        );
        for (const s of dashSessions) {
          if (warmAbort.signal.aborted) break;
          // Fire-and-forget; endpoint always 200s and effect is invisible cache population.
          fetch(`${API_BASE}/agents/sessions/${s.id}/warm-cache`, {
            method: 'POST',
            signal: warmAbort.signal,
          }).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    }, 250);

    return () => {
      clearTimeout(warmTimer);
      warmAbort.abort();
      cleanupBrowserHandler();
      dashboardWs.disconnect();
      // Cancel any unfired idle work so the cleanup handler can't run partially after dashboard switch.
      if (typeof window !== 'undefined') {
        const cancelIdle = (window as any).cancelIdleCallback;
        if (cancelIdle && typeof idleHandle === 'number') cancelIdle(idleHandle);
        else if (typeof idleHandle === 'number') clearTimeout(idleHandle);
      }
    };
  }, [dispatch, dashboardId]);

  const pendingBrowserUrl = useAppSelector((state) => state.tempState.pendingBrowserUrl);
  const pendingFocusAgentId = useAppSelector((state) => state.tempState.pendingFocusAgentId);
  const pendingFocusBrowserId = useAppSelector((state) => state.dashboardLayout.pendingFocusBrowserId);
  const pendingFocusWorkflowId = useAppSelector((state) => state.dashboardLayout.pendingFocusWorkflowId);
  const pendingFocusWorkflowsHub = useAppSelector((state) => state.dashboardLayout.pendingFocusWorkflowsHub);

  useEffect(() => {
    if (!dashboardId) return;
    (window as any).__openswarm_last_dashboard_id = dashboardId;
  }, [dashboardId]);

  useEffect(() => {
    if (!pendingBrowserUrl || !layoutInitialized) return;
    dispatch(addBrowserCard({ url: pendingBrowserUrl, expandedSessionIds }));
    dispatch(clearPendingBrowserUrl());
  }, [pendingBrowserUrl, layoutInitialized, dispatch, expandedSessionIds]);

  // Native capturePage thumbnail; captures viewport as-is and piggybacks on the layout save debounce.
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
    if (!hasCards) {
      // Empty dashboard: queue a thumbnail clear (backend treats '' as "set empty", null as "no change").
      pendingThumbnailRef.current = '';
      return;
    }
    captureDashboardThumbnail(viewportEl, contentEl, allCards)
      .then((thumbnail) => { if (thumbnail) pendingThumbnailRef.current = thumbnail; })
      .catch(() => {});
  }, [canvas.viewportRef, canvas.contentRef]);

  useEffect(() => {
    if (!isActive) return;  // Skip thumbnail capture when dashboard is hidden
    if (!dashboardId || !layoutInitialized) return;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(captureNow, 2000);
    return () => { if (captureTimerRef.current) clearTimeout(captureTimerRef.current); };
  }, [isActive, dashboardId, layoutInitialized, captureNow]);

  useEffect(() => {
    if (!dashboardId) return;
    const exitingId = dashboardId;
    return () => {
      const thumbnail = pendingThumbnailRef.current;
      // null = no pending change; '' = pending clear; other = pending update.
      if (thumbnail !== null) {
        store.dispatch(updateDashboardThumbnail({ id: exitingId, thumbnail }));
        pendingThumbnailRef.current = null;
      }
    };
  }, [dashboardId]);

  useEffect(() => {
    if (!isActive) return;  // Don't auto-fit while dashboard is hidden
    if (!layoutInitialized || hasFittedRef.current) return;
    if (pendingFocusAgentId) return;
    hasFittedRef.current = true;
    const timer = setTimeout(() => canvas.actions.fitToView(), 150);
    return () => clearTimeout(timer);
  }, [isActive, layoutInitialized, canvas.actions, pendingFocusAgentId]);

  useEffect(() => {
    if (!isActive) return;  // Defer focus animation until dashboard is visible
    if (!pendingFocusAgentId || !layoutInitialized) return;
    const agentId = pendingFocusAgentId;
    dispatch(clearPendingFocusAgentId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.cards[agentId];
      if (card) {
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(agentId);
      }
    }, 350);
  }, [isActive, pendingFocusAgentId, layoutInitialized, dispatch, canvas.actions, handleHighlightCard]);

  // Auto-focus newly created browser card; zoom=0.8 matches the click-to-focus experience for 1280x800 cards.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingFocusBrowserId || !layoutInitialized) return;
    const browserId = pendingFocusBrowserId;
    dispatch(clearPendingFocusBrowserId());
    hasFittedRef.current = true;
    setTimeout(() => {
      const card = store.getState().dashboardLayout.browserCards[browserId];
      if (card) {
        canvas.actions.fitToCards(
          [{ x: card.x, y: card.y, width: card.width, height: card.height }],
          1.15,
          true,
          0.8,
        );
        handleHighlightCard(browserId);
      }
    }, 200);
  }, [isActive, pendingFocusBrowserId, layoutInitialized, dispatch, canvas.actions, handleHighlightCard]);

  // Same pan/highlight choreography for newly-spawned workflow cards.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingFocusWorkflowId || !layoutInitialized) return;
    const workflowId = pendingFocusWorkflowId;
    dispatch(clearPendingFocusWorkflowId());
    setTimeout(() => {
      const card = store.getState().dashboardLayout.workflowCards[workflowId];
      if (card) {
        canvas.actions.fitToCards(
          [{ x: card.x, y: card.y, width: card.width, height: card.height }],
          1.15,
          true,
        );
        handleHighlightCard(workflowId);
      }
    }, 200);
  }, [isActive, pendingFocusWorkflowId, layoutInitialized, dispatch, canvas.actions, handleHighlightCard]);

  // Pan/zoom to Workflows Hub on Expand; chained rAFs ensure fit runs after the hub div lands at its new coords.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingFocusWorkflowsHub || !layoutInitialized) return;
    dispatch(clearPendingFocusWorkflowsHub());
    const fit = () => {
      const hub = store.getState().dashboardLayout.workflowsHub;
      if (!hub) return;
      canvas.actions.fitToCards(
        [{ x: hub.x, y: hub.y, width: hub.width, height: hub.height }],
        1.1,
        true,
      );
    };
    // Two rAFs (state to render, layout to settle) + fallback timeout for slow boots.
    requestAnimationFrame(() => requestAnimationFrame(fit));
    const fallback = setTimeout(fit, 300);
    return () => clearTimeout(fallback);
  }, [isActive, pendingFocusWorkflowsHub, layoutInitialized, dispatch, canvas.actions]);

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

  // Prune orphan view cards whose underlying output was deleted; gated on outputsLoaded to avoid wiping valid cards during fetch race.
  useEffect(() => {
    if (!layoutInitialized || !outputsLoaded) return;
    for (const outputId of Object.keys(viewCards)) {
      if (!outputs[outputId]) dispatch(removeViewCard(outputId));
    }
  }, [layoutInitialized, outputsLoaded, viewCards, outputs, dispatch]);

  const autoRevealedRef = useRef(new Set<string>());
  const prevSubStatusRef = useRef<Record<string, string>>({});
  const prevParentStatusRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!isActive) return;  // Heavy logic; pause when dashboard is hidden.
    if (!layoutInitialized || !autoRevealSubAgents) return;

    const subSessions = Object.values(sessions).filter(
      (s) => (s.mode === 'sub-agent' || s.mode === 'invoked-agent') && s.parent_session_id,
    );

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
        // Pass expandedSessionIds so placeCard's collision check uses real visual heights (~620px expanded).
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

  const skipInitialSave = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Parameters<typeof saveLayout>[0] | null>(null);

  useEffect(() => {
    if (!isActive) return;  // Don't persist while hidden; pendingSaveRef buffers and flushes on resume.
    if (!layoutInitialized || !dashboardId) return;
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    const payload = { dashboardId, cards, viewCards, browserCards, workflowCards, workflowsHub, notes, expandedSessionIds };
    pendingSaveRef.current = payload;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      dispatch(saveLayout(payload));
      pendingSaveRef.current = null;
      saveTimerRef.current = null;
      captureNow();
    }, 500);
  }, [isActive, cards, viewCards, browserCards, workflowCards, workflowsHub, notes, expandedSessionIds, layoutInitialized, dashboardId, dispatch, captureNow]);

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
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
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
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
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
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
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
        } else if (type === 'note') {
          dispatch(removeNote(id));
        } else if (type === 'workflow') {
          dispatch(removeWorkflowCard(id));
          dispatch(closeWorkflowCard(id));
        }
      }
      selection.deselectAll();
    };
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [selection, dispatch]);

  useEffect(() => {
    const handleSearch = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      setSearchPaletteOpen(true);
      report('dashboard', 'search_opened');
    };
    window.addEventListener('keydown', handleSearch);
    return () => window.removeEventListener('keydown', handleSearch);
  }, []);

  useEffect(() => {
    const handleCopy = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
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
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden
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
            dispatch(placeCard({
              sessionId: newId,
              x: px,
              y: py,
              width: card.width,
              height: card.height,
              expandedSessionIds,
            }));
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

  const findNearestCard = useCallback((
    currentId: string,
    direction: 'left' | 'right' | 'up' | 'down',
  ): { id: string; type: CardType } | null => {
    const allCardEntries: Array<{ id: string; type: CardType; cx: number; cy: number }> = [];
    for (const card of Object.values(cards)) {
      allCardEntries.push({ id: card.session_id, type: 'agent', cx: card.x + card.width / 2, cy: card.y + card.height / 2 });
    }
    for (const vc of Object.values(viewCards)) {
      allCardEntries.push({ id: vc.output_id, type: 'view', cx: vc.x + vc.width / 2, cy: vc.y + vc.height / 2 });
    }
    for (const bc of Object.values(browserCards)) {
      allCardEntries.push({ id: bc.browser_id, type: 'browser', cx: bc.x + bc.width / 2, cy: bc.y + bc.height / 2 });
    }
    for (const wc of Object.values(workflowCards)) {
      allCardEntries.push({ id: wc.workflow_id, type: 'workflow', cx: wc.x + wc.width / 2, cy: wc.y + wc.height / 2 });
    }

    const current = allCardEntries.find((c) => c.id === currentId);
    if (!current) return null;

    let best: typeof allCardEntries[0] | null = null;
    let bestScore = Infinity;

    for (const card of allCardEntries) {
      if (card.id === currentId) continue;
      const dx = card.cx - current.cx;
      const dy = card.cy - current.cy;

      let inDirection = false;
      let primary = 0;
      let secondary = 0;
      switch (direction) {
        case 'right': inDirection = dx > 20; primary = dx; secondary = Math.abs(dy); break;
        case 'left':  inDirection = dx < -20; primary = -dx; secondary = Math.abs(dy); break;
        case 'down':  inDirection = dy > 20; primary = dy; secondary = Math.abs(dx); break;
        case 'up':    inDirection = dy < -20; primary = -dy; secondary = Math.abs(dx); break;
      }
      if (!inDirection) continue;

      const score = primary + secondary * 0.3;
      if (score < bestScore) {
        bestScore = score;
        best = card;
      }
    }

    return best ? { id: best.id, type: best.type } : null;
  }, [cards, viewCards, browserCards, workflowCards]);

  const neighborDirections = useMemo(() => {
    // Below zoom 0.4 cards are too small to be useful nav targets.
    if (!focusedCardId || canvas.zoom < 0.4) return { left: false, right: false, up: false, down: false };
    return {
      left: !!findNearestCard(focusedCardId, 'left'),
      right: !!findNearestCard(focusedCardId, 'right'),
      up: !!findNearestCard(focusedCardId, 'up'),
      down: !!findNearestCard(focusedCardId, 'down'),
    };
  }, [focusedCardId, canvas.zoom, findNearestCard]);

  const [shakeDirection, setShakeDirection] = useState<'left' | 'right' | 'up' | 'down' | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs avoid stale closures inside the keydown handler.
  const focusedCardIdRef = useRef(focusedCardId);
  focusedCardIdRef.current = focusedCardId;
  const canvasZoomRef = useRef(canvas.zoom);
  canvasZoomRef.current = canvas.zoom;

  useEffect(() => {
    // True only when the input has content; empty inputs don't need arrows so we repurpose them for nav.
    const isActivelyEditing = (target: EventTarget | null): boolean => {
      const el = (target as HTMLElement) || (document.activeElement as HTMLElement | null);
      if (!el) return false;
      const tag = el.tagName;
      const editable = (el as any).isContentEditable;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !editable) return false;
      const val = (el as HTMLInputElement | HTMLTextAreaElement).value;
      if (typeof val === 'string' && val.length === 0) return false;
      if (editable && (el.textContent ?? '').length === 0) return false;
      return true;
    };

    const handleKey = (e: KeyboardEvent) => {
      if (!isActive) return;  // Don't fire shortcuts when dashboard is hidden

      // Escape blurs active input so users can unstick focus and start navigating.
      if (e.key === 'Escape') {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (active as any)?.isContentEditable) {
          active?.blur?.();
        }
        return;
      }

      let direction: 'left' | 'right' | 'up' | 'down' | null = null;
      switch (e.key) {
        case 'ArrowLeft': direction = 'left'; break;
        case 'ArrowRight': direction = 'right'; break;
        case 'ArrowUp': direction = 'up'; break;
        case 'ArrowDown': direction = 'down'; break;
        default: return;
      }

      if (isActivelyEditing(e.target)) return;
      if (canvasZoomRef.current < 0.4) return;

      let currentFocused = focusedCardIdRef.current;
      if (!currentFocused) {
        const anyCardId = Object.keys(cards)[0] || Object.keys(viewCards)[0] || Object.keys(browserCards)[0];
        if (!anyCardId) return;
        currentFocused = anyCardId;
        setFocusedCardId(anyCardId);
      }

      e.preventDefault();
      const target = findNearestCard(currentFocused, direction);

      if (!target) {
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
        setShakeDirection(direction);
        shakeTimerRef.current = setTimeout(() => {
          setShakeDirection(null);
          shakeTimerRef.current = null;
        }, 400);
        return;
      }

      report('dashboard', 'arrow_navigated', { direction, from_card: currentFocused, to_card: target.id });
      if (target.type === 'agent') {
        dispatch(expandSession(target.id));
      }
      dispatch(bringToFront({ id: target.id, type: target.type }));
      setFocusedCardId(target.id);

      setTimeout(() => {
        const rect = getCardRect(target.id, target.type);
        if (rect) canvas.actions.fitToCards([rect], 1.15, true);
        setTimeout(() => (document.activeElement as HTMLElement)?.blur?.(), 150);
      }, 100);
    };

    // Capture phase beats MUI Menus/Selects; isActivelyEditing early-return prevents interference with typing.
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [findNearestCard, getCardRect, canvas.actions, dispatch, isActive, cards, viewCards, browserCards]);

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
        expandedSessionIds,
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
      report('dashboard', 'agent_created', { mode, model, has_images: !!images?.length, has_context: !!contextPaths?.length, has_browser: !!selectedBrowserIds?.length });

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
                // placeCard cascades to a free cell if the ideal "left of browser" spot is taken.
                dispatch(placeCard({
                  sessionId: realId,
                  x: bc.x - DEFAULT_CARD_W - GRID_GAP * 12,
                  y: bc.y,
                  width: DEFAULT_CARD_W,
                  height: DEFAULT_CARD_H,
                  expandedSessionIds,
                }));
              }
            }
          }
          spawnOriginsRef.current[realId] = spawnOriginsRef.current[draftId];
          delete spawnOriginsRef.current[draftId];

          if (expandNewChats) {
            setAutoFocusSessionId(realId);
            dispatch(expandSession(realId));
          } else {
            setPendingSelectSessionId(realId);
          }

          setTimeout(() => {
            const card = store.getState().dashboardLayout.cards[realId];
            if (card) {
              canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
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
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(outputId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvas.actions, handleHighlightCard]);

  const handleAddBrowser = useCallback(() => {
    report('dashboard', 'browser_added');
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.browserCards));
    dispatch(addBrowserCard({ url: browserHomepage, expandedSessionIds }));
    setTimeout(() => {
      const allBrowserCards = store.getState().dashboardLayout.browserCards;
      const newId = Object.keys(allBrowserCards).find((id) => !prevIds.has(id));
      if (newId) {
        const card = allBrowserCards[newId];
        canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, browserHomepage, expandedSessionIds, canvas.actions, handleHighlightCard]);

  const handleAddNote = useCallback(() => {
    report('dashboard', 'note_added');
    const prevIds = new Set(Object.keys(store.getState().dashboardLayout.notes));
    dispatch(addNote({ expandedSessionIds }));
    setTimeout(() => {
      const allNotes = store.getState().dashboardLayout.notes;
      const newId = Object.keys(allNotes).find((id) => !prevIds.has(id));
      if (newId) {
        const note = allNotes[newId];
        canvas.actions.fitToCards([{ x: note.x, y: note.y, width: note.width, height: note.height }], 1.15, true);
        handleHighlightCard(newId);
      }
    }, 200);
  }, [dispatch, expandedSessionIds, canvas.actions, handleHighlightCard]);

  useEffect(() => {
    if (!pendingFocusNoteId) return;
    const t = setTimeout(() => dispatch(clearPendingFocusNoteId()), 800);
    return () => clearTimeout(t);
  }, [pendingFocusNoteId, dispatch]);

  const handleHistoryResume = useCallback((sessionId: string) => {
    dispatch(resumeSession({ sessionId })).then((action) => {
      if (resumeSession.fulfilled.match(action)) {
        dispatch(expandSession(sessionId));
        setAutoFocusSessionId(sessionId);
        setTimeout(() => {
          const card = store.getState().dashboardLayout.cards[sessionId];
          if (card) {
            canvas.actions.fitToCards([{ x: card.x, y: card.y, width: card.width, height: card.height }], 1.15, true);
            handleHighlightCard(sessionId);
          }
        }, 200);
      }
    });
  }, [dispatch, canvas.actions, handleHighlightCard, setAutoFocusSessionId]);

  const handleFitToView = useCallback(() => {
    report('dashboard', 'fit_to_view', { has_selection: selection.selectedIds.size > 0 });
    if (selection.selectedIds.size === 1) {
      const [[id, type]] = selection.selectedIds;
      const rect = getCardRect(id, type);
      if (rect) {
        canvas.actions.fitToCards([rect], 1.15, true);
        return;
      }
    }
    canvas.actions.fitToView();
  }, [selection.selectedIds, getCardRect, canvas.actions]);

  const handleTidy = useCallback(() => {
    report('dashboard', 'tidy_layout');
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
    if (!isActive) return;  // Heavy geometry recalculation; pause when dashboard is hidden.
    const DRIFT_THRESHOLD = 60;

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
  // measuredHeightsTick in deps: re-run after ResizeObserver reports the post-collapse height.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, expandedSessionIds, glowingAgentCards, cards, dispatch, measuredHeightsTick]);

  useEffect(() => {
    if (!isActive) return;  // Heavy geometry recalculation; pause when dashboard is hidden.
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

    // Browser tethers merge from two sources: glowingBrowserCards (initial flash) and active browser-agent sessions (persistent).
    type Anchor = { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' };

    function browserTether(
      browserId: string,
      sourceId: string,
      fading: boolean,
      label: string,
    ) {
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
      if (glowTethers.has(s.browser_id)) continue; // glow already covers this one
      const t = browserTether(s.browser_id, s.parent_session_id, false, '');
      if (t) glowTethers.set(s.browser_id, t);
    }

    const browserTethers = Array.from(glowTethers.values()).filter(Boolean) as Array<{ key: string; path: string; labelX: number; labelY: number; label: string; fading: boolean }>;

    // Workflow tethers reuse the browser-tether anchor/elbow math; skip deleted workflows to avoid dangling arrows.
    const workflowTethers: Array<{ key: string; path: string; labelX: number; labelY: number; label: string; fading: boolean }> = [];
    for (const wc of Object.values(workflowCards)) {
      const sourceId = wc.source_session_id;
      if (!sourceId) continue;
      const src = cards[sourceId];
      if (!src) continue;
      // Defense-in-depth: layout entry can outlive its workflow when deleted from the hub.
      const hasReal = wc.workflow_id in workflowItems;
      const hasDraft = wc.workflow_id in workflowOpenCards;
      if (!hasReal && !hasDraft) continue;

      let srcX = src.x, srcY = src.y;
      let dstX = wc.x, dstY = wc.y;
      if (liveDragInfo) {
        if (liveDragInfo.cardId === sourceId) { srcX += liveDragInfo.dx; srcY += liveDragInfo.dy; }
        if (liveDragInfo.cardId === wc.workflow_id) { dstX += liveDragInfo.dx; dstY += liveDragInfo.dy; }
      }

      const srcMeasured = measuredHeightsRef.current[sourceId];
      const srcH = srcMeasured ?? (expandedSessionIds.includes(sourceId)
        ? Math.max(EXPANDED_CARD_MIN_H, src.height)
        : src.height);

      const srcCx = srcX + src.width / 2;
      const dstCx = dstX + wc.width / 2;
      const srcAnchors: Anchor[] = [
        { x: srcX + src.width, y: srcY + srcH * 0.54, side: 'right' },
        { x: srcX, y: srcY + srcH * 0.54, side: 'left' },
        { x: srcCx, y: srcY, side: 'top' },
        { x: srcCx, y: srcY + srcH, side: 'bottom' },
      ];
      const dstAnchors: Anchor[] = [
        { x: dstX, y: dstY + wc.height * 0.54, side: 'left' },
        { x: dstX + wc.width, y: dstY + wc.height * 0.54, side: 'right' },
        { x: dstCx, y: dstY, side: 'top' },
        { x: dstCx, y: dstY + wc.height, side: 'bottom' },
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

    return [...agentTethers, ...browserTethers, ...workflowTethers];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowingAgentCards, glowingBrowserCards, cards, browserCards, workflowCards, workflowItems, workflowOpenCards, expandedSessionIds, liveDragInfo, measuredHeightsTick, sessionList]);

  const dotSize = Math.max(1, 1.5 * canvas.zoom);
  const dotSpacing = 24 * canvas.zoom;

  return (
    <>
    <DashboardSelectionOverlay />
    <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          pointerEvents: 'none',
          // 0.75 (6px) keeps the header tight against the sidebar; 24px read as two disconnected panels.
          p: 0.75,
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

      <Box
        ref={canvas.viewportRef}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onDoubleClick={handleViewportDoubleClick}
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
            <style>{`@keyframes empty-state-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
            <Typography sx={{ color: c.text.tertiary, fontSize: '1.1rem', mb: 1 }}>
              No agents running
            </Typography>
            <Typography
              sx={{
                fontSize: '0.9rem',
                background: `linear-gradient(90deg, ${c.text.ghost} 0%, ${c.text.ghost} 40%, ${c.text.primary} 50%, ${c.text.ghost} 60%, ${c.text.ghost} 100%)`,
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                color: 'transparent',
                animation: 'empty-state-shimmer 6s linear infinite',
              }}
            >
              Click the &quot;+&quot; button below to launch your first agent
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
                      opacity={0.15}
                      filter="url(#tether-glow-f)"
                    />
                    <path
                      d={t.path}
                      fill="none"
                      stroke={c.accent.primary}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.8}
                      markerEnd="url(#tether-arrow)"
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
              const sid = card.session_id;

              let origin = spawnOriginsRef.current[sid];
              if (origin) {
                delete spawnOriginsRef.current[sid];
              } else {
                const glow = glowingAgentCards[sid];
                if (glow && !revealSpawnedRef.current.has(sid)) {
                  revealSpawnedRef.current.add(sid);
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
              const glow = glowingAgentCards[sid];
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

              const isSel = selection.isSelected(sid);
              return (
                <AgentCard
                  key={sid}
                  sessionId={sid}
                  expanded={expandedSessionIds.includes(sid)}
                  getCanvasState={getCanvasState}
                  spawnFrom={origin}
                  exitTarget={exitTarget}
                  isSelected={isSel}
                  isHighlighted={highlightedCardId === sid}
                  // Only selected cards get live drag delta; passing to all broke memo equality during multi-drag.
                  multiDragDelta={isSel ? multiDragDelta : null}
                  onCardSelect={handleCardSelect}
                  onDragStart={handleCardDragStart}
                  onDragMove={handleCardDragMove}
                  onDragEnd={handleCardDragEnd}
                  onBranch={handleBranchFromCard}
                  onMeasuredHeight={handleMeasuredHeight}
                  snapColumn={snapColumn}
                  autoFocusInput={autoFocusSessionId === sid}
                  onDoubleClick={handleCardDoubleClick}
                  onBringToFront={handleBringToFront}
                  shakeDirection={focusedCardId === sid ? shakeDirection : null}
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
                  panX={canvas.panX}
                  panY={canvas.panY}
                  cmdHeld={canvas.cmdHeld}
                  isSelected={selection.isSelected(vc.output_id)}
                  isHighlighted={highlightedCardId === vc.output_id}
                  multiDragDelta={multiDragDelta}
                  onCardSelect={handleCardSelect}
                  onDragStart={handleCardDragStart}
                  onDragMove={handleCardDragMove}
                  onDragEnd={handleCardDragEnd}
                  onDoubleClick={handleCardDoubleClick}
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
                panX={canvas.panX}
                panY={canvas.panY}
                cmdHeld={canvas.cmdHeld}
                isSelected={selection.isSelected(bc.browser_id)}
                isHighlighted={highlightedCardId === bc.browser_id}
                multiDragDelta={multiDragDelta}
                onCardSelect={handleCardSelect}
                onDragStart={handleCardDragStart}
                onDragMove={handleCardDragMove}
                onDragEnd={handleCardDragEnd}
                onDoubleClick={handleCardDoubleClick}
                onBringToFront={handleBringToFront}
              />
            ))}
            {workflowsHub && (
              <WorkflowsHubCard
                cardX={workflowsHub.x}
                cardY={workflowsHub.y}
                cardWidth={workflowsHub.width}
                cardHeight={workflowsHub.height}
                cardZOrder={workflowsHub.zOrder ?? 0}
                zoom={canvas.zoom}
                panX={canvas.panX}
                panY={canvas.panY}
              />
            )}
            {Object.values(workflowCards).map((wc) => (
              <WorkflowCard
                key={`workflow-${wc.workflow_id}`}
                workflowId={wc.workflow_id}
                cardX={wc.x}
                cardY={wc.y}
                cardWidth={wc.width}
                cardHeight={wc.height}
                cardZOrder={wc.zOrder ?? 0}
                zoom={canvas.zoom}
                panX={canvas.panX}
                panY={canvas.panY}
                isSelected={selection.isSelected(wc.workflow_id)}
                isHighlighted={highlightedCardId === wc.workflow_id}
                multiDragDelta={multiDragDelta}
                onCardSelect={handleCardSelect}
                onDragStart={handleCardDragStart}
                onDragMove={handleCardDragMove}
                onDragEnd={handleCardDragEnd}
                onDoubleClick={handleCardDoubleClick}
                onBringToFront={handleBringToFront}
              />
            ))}
            {Object.values(notes).map((n) => (
              <NoteCard
                key={`note-${n.note_id}`}
                noteId={n.note_id}
                cardX={n.x}
                cardY={n.y}
                cardWidth={n.width}
                cardHeight={n.height}
                cardZOrder={n.zOrder ?? 0}
                zoom={canvas.zoom}
                panX={canvas.panX}
                panY={canvas.panY}
                cmdHeld={canvas.cmdHeld}
                content={n.content}
                color={n.color}
                isSelected={selection.isSelected(n.note_id)}
                isHighlighted={highlightedCardId === n.note_id}
                multiDragDelta={multiDragDelta}
                autoFocus={pendingFocusNoteId === n.note_id}
                onCardSelect={handleCardSelect}
                onDragStart={handleCardDragStart}
                onDragMove={handleCardDragMove}
                onDragEnd={handleCardDragEnd}
                onBringToFront={handleBringToFront}
              />
            ))}
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
          onAddNote={handleAddNote}
          dashboardId={dashboardId}
          newAgentBounce={newAgentBounce}
          onNewAgentBounceEnd={() => setNewAgentBounce(false)}
        />
      </Box>

      {focusedCardId && canvas.zoom >= 0.4 && (
        <DirectionHints
          hasLeft={neighborDirections.left}
          hasRight={neighborDirections.right}
          hasUp={neighborDirections.up}
          hasDown={neighborDirections.down}
          shakeDirection={shakeDirection}
        />
      )}

      <Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}>
        <CanvasControls
          zoom={canvas.zoom}
          actions={canvas.actions}
          onFitToView={handleFitToView}
          onTidy={handleTidy}
          minimapProps={{
            panX: canvas.panX,
            panY: canvas.panY,
            zoom: canvas.zoom,
            viewportRef: canvas.viewportRef,
            cards,
            viewCards,
            browserCards,
          }}
          onMinimapPan={(px, py) => canvas.actions.setState({ panX: px, panY: py, zoom: canvas.zoom })}
        />
      </Box>
    </Box>

    <CardSearchPalette
      open={searchPaletteOpen}
      onClose={() => setSearchPaletteOpen(false)}
      onNavigate={(rect) => canvas.actions.fitToCards([rect], 1.15, true)}
      cards={cards}
      viewCards={viewCards}
      browserCards={browserCards}
      sessions={sessions}
    />

    </>
  );
};

const Dashboard: React.FC<DashboardProps> = ({ dashboardId, isActive = true }) => (
  <ElementSelectionProvider>
    <DashboardInner dashboardId={dashboardId} isActive={isActive} />
  </ElementSelectionProvider>
);

export default Dashboard;
