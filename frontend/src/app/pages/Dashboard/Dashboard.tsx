import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { toggleExpandSession } from '@/shared/state/agentsSlice';
import { UPDATE_DASHBOARD } from '@/shared/backend-bridge/apps/dashboards';
import { useCanvasControls } from './hooks/useCanvasControls/useCanvasControls';
import { useDashboardSelection } from './hooks/useDashboardSelection';
import { ElementSelectionProvider } from '@/app/pages/_shared/element_selection/ElementSelectionProvider';
import { useElementSelection } from '@/app/pages/_shared/element_selection/useElementSelection';
import { useDomElementSelector } from './hooks/useDomElementSelector/useDomElementSelector';
import SelectionOverlay from './SelectionOverlay';
import { useDashboardDrag } from './hooks/useDashboardDrag';
import { useDashboardKeyboard } from './hooks/useDashboardKeyboard';
import { useDashboardThumbnail } from './hooks/useDashboardThumbnail/useDashboardThumbnail';
import { useDashboardInit } from './hooks/useDashboardInit';
import { useSubAgentAutoReveal } from './hooks/useSubAgentAutoReveal';
import { useTetherPaths } from './hooks/useTetherPaths';
import { useToolbarActions } from './hooks/useToolbarActions';
import DashboardCanvas from './DashboardCanvas/DashboardCanvas';

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
  const dispatch = useAppDispatch();
  const { id: dashboardId } = useParams<{ id: string }>();
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;
  const dashboardName = useAppSelector((s) => dashboardId ? s.dashboards.items[dashboardId]?.name : undefined);
  const sessions = useAppSelector((s) => s.agents.sessions);
  const expandedSessionIds = useAppSelector((s) => s.agents.expandedSessionIds);
  const cards = useAppSelector((s) => s.dashboardLayout.cards);
  const viewCards = useAppSelector((s) => s.dashboardLayout.viewCards);
  const browserCards = useAppSelector((s) => s.dashboardLayout.browserCards);
  const layoutInitialized = useAppSelector((s) => s.dashboardLayout.initialized);
  const persistedExpandedSessionIds = useAppSelector((s) => s.dashboardLayout.persistedExpandedSessionIds);
  const zoomSensitivity = useAppSelector((s) => s.settings.data.zoom_sensitivity);
  const newAgentShortcut = useAppSelector((s) => s.settings.data.new_agent_shortcut);
  const browserHomepage = useAppSelector((s) => s.settings.data.browser_homepage);
  const expandNewChats = useAppSelector((s) => s.settings.data.expand_new_chats_in_dashboard);
  const autoRevealSubAgents = useAppSelector((s) => s.settings.data.auto_reveal_sub_agents);
  const outputs = useAppSelector((s) => s.apps.items);
  const glowingAgentCards = useAppSelector((s) => s.dashboardLayout.glowingAgentCards);
  const glowingBrowserCards = useAppSelector((s) => s.dashboardLayout.glowingBrowserCards);
  const pendingBrowserUrl = useAppSelector((s) => s.tempState.pendingBrowserUrl);
  const pendingFocusAgentId = useAppSelector((s) => s.tempState.pendingFocusAgentId);
  const sessionList = Object.values(sessions);

  const canvas = useCanvasControls(zoomSensitivity);
  const selection = useDashboardSelection(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, viewportRef: canvas.viewportRef },
    cards, viewCards, browserCards,
  );

  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
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
    if (!pendingSelectSessionId || !cards[pendingSelectSessionId]) return;
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
    revealSpawnedRef.current.forEach((id) => { if (!cards[id]) revealSpawnedRef.current.delete(id); });
  }, [cards]);
  const canvasStateRef = useRef({ panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom });
  canvasStateRef.current = { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom };

  const drag = useDashboardDrag(selection);

  const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) { canvas.handlers.onMouseDown(e); return; }
    if (e.button === 2) { e.preventDefault(); canvas.handlers.onMouseDown(e); return; }
    if (e.button !== 0) return;
    if (isCardTarget(e.target, e.currentTarget)) return;
    if (isElementSelectMode) {
      if (e.metaKey || e.ctrlKey) canvas.handlers.onMouseDown(e);
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

  useDashboardInit({
    dashboardId, layoutInitialized, expandedSessionIds,
    persistedExpandedSessionIds, sessions, cards, canvasActions: canvas.actions,
    handleHighlightCard, pendingBrowserUrl, pendingFocusAgentId, measuredHeightsRef,
  });

  const { captureNow } = useDashboardThumbnail(
    canvas.viewportRef, canvas.contentRef, dashboardId, layoutInitialized,
  );

  const handleFocusRequest = useCallback((sessionId: string) => {
    if (!expandedSessionIds.includes(sessionId)) dispatch(toggleExpandSession(sessionId));
    setFocusedCardId(sessionId);
  }, [expandedSessionIds, dispatch]);

  const handleFocusExit = useCallback(() => setFocusedCardId(null), []);

  useDashboardKeyboard({
    newAgentShortcut, setToolbarOpen,
    selectedIds: selection.selectedIds, deselectAll: selection.deselectAll, selectCard: selection.selectCard,
    focusedCardId, setFocusedCardId, handleFocusRequest,
    sessions, cards, viewCards, browserCards, outputs, expandedSessionIds, dashboardId,
  });

  useSubAgentAutoReveal({
    sessions, cards, browserCards, layoutInitialized, autoRevealSubAgents,
    expandedSessionIds, glowingAgentCards, glowingBrowserCards, measuredHeightsRef, measuredHeightsTick,
  });

  const skipInitialSave = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Parameters<typeof UPDATE_DASHBOARD>[0] | null>(null);
  useEffect(() => {
    if (!layoutInitialized || !dashboardId) return;
    if (skipInitialSave.current) { skipInitialSave.current = false; return; }
    const payload = {
      dashboardId,
      layout: {
        cards,
        view_cards: viewCards,
        browser_cards: browserCards,
        expanded_session_ids: expandedSessionIds,
      },
    };
    pendingSaveRef.current = payload;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      dispatch(UPDATE_DASHBOARD(payload));
      pendingSaveRef.current = null;
      saveTimerRef.current = null;
      captureNow();
    }, 500);
  }, [cards, viewCards, browserCards, expandedSessionIds, layoutInitialized, dashboardId, dispatch, captureNow]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      if (pendingSaveRef.current) { dispatch(UPDATE_DASHBOARD(pendingSaveRef.current)); pendingSaveRef.current = null; }
    };
  }, [dispatch]);

  const toolbar = useToolbarActions({
    cards, expandedSessionIds, viewportRef: canvas.viewportRef, canvasActions: canvas.actions,
    canvasStateRef, toolbarRef, spawnOriginsRef, dashboardId, expandNewChats,
    handleHighlightCard, browserHomepage, setAutoFocusSessionId, setPendingSelectSessionId, setToolbarOpen,
  });

  const tethers = useTetherPaths({
    glowingAgentCards, glowingBrowserCards, cards, browserCards,
    expandedSessionIds, liveDragInfo: drag.liveDragInfo, measuredHeightsRef, measuredHeightsTick,
  });

  return (
    <>
      <DashboardSelectionOverlay />
      <DashboardCanvas
        panX={canvas.panX} panY={canvas.panY} zoom={canvas.zoom}
        isPanning={canvas.isPanning} spaceHeld={canvas.spaceHeld} cmdHeld={canvas.cmdHeld}
        viewportRef={canvas.viewportRef} contentRef={canvas.contentRef}
        sessions={sessions} sessionList={sessionList} cards={cards} viewCards={viewCards}
        browserCards={browserCards} outputs={outputs} expandedSessionIds={expandedSessionIds}
        glowingAgentCards={glowingAgentCards}
        marquee={selection.marquee} isSelected={selection.isSelected}
        multiDragDelta={drag.multiDragDelta}
        handleCardSelect={drag.handleCardSelect} handleCardDragStart={drag.handleCardDragStart}
        handleCardDragMove={drag.handleCardDragMove} handleCardDragEnd={drag.handleCardDragEnd}
        handleBringToFront={drag.handleBringToFront} handleBranchFromCard={toolbar.handleBranchFromCard}
        handleFocusRequest={handleFocusRequest} handleFocusExit={handleFocusExit}
        focusedCardId={focusedCardId} highlightedCardId={highlightedCardId}
        autoFocusSessionId={autoFocusSessionId} tethers={tethers}
        toolbarRef={toolbarRef} toolbarOpen={toolbarOpen}
        handleNewAgent={toolbar.handleNewAgent} handleToolbarCancel={toolbar.handleToolbarCancel}
        handleToolbarSend={toolbar.handleToolbarSend} handleAddView={toolbar.handleAddView}
        handleHistoryResume={toolbar.handleHistoryResume} handleAddBrowser={toolbar.handleAddBrowser}
        handleTidy={toolbar.handleTidy} canvasActions={canvas.actions}
        dashboardId={dashboardId} dashboardName={dashboardName}
        onHighlightCard={handleHighlightCard} handleMeasuredHeight={handleMeasuredHeight}
        spawnOriginsRef={spawnOriginsRef} revealSpawnedRef={revealSpawnedRef}
        measuredHeightsRef={measuredHeightsRef}
        handleViewportMouseDown={handleViewportMouseDown}
        handleViewportMouseMove={handleViewportMouseMove}
        handleViewportMouseUp={handleViewportMouseUp}
      />
    </>
  );
};

const Dashboard: React.FC = () => (
  <ElementSelectionProvider>
    <DashboardInner />
  </ElementSelectionProvider>
);

export default Dashboard;
