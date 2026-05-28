import { useCallback, useMemo, useRef } from 'react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { useCanvasControls } from '../interaction/useCanvasControls';
import { useDashboardSelection } from './useDashboardSelection';
import { useDashboardSelectors } from './useDashboardSelectors';
import { getCardRect } from '../../geometry/getCardRect';
import { computeContentBounds } from '../../geometry/contentBounds';
import { useDashboardUiState } from './useDashboardUiState';
import { useLayoutSave } from './useLayoutSave';
import { useTethers } from '../../geometry/dashboardTethers';
import { useArrowNav } from '../interaction/useArrowNav';
import { useDashboardShortcuts } from '../interaction/useDashboardShortcuts';
import { useDashboardClipboard } from '../interaction/useDashboardClipboard';
import { useCardDrag } from '../interaction/useCardDrag';
import { useSubAgentLifecycle } from '../lifecycle/useSubAgentLifecycle';
import { useDashboardLifecycle } from '../lifecycle/useDashboardLifecycle';
import { useDashboardThumbnail } from './useDashboardThumbnail';
import { useSiblingRestack } from '../lifecycle/useSiblingRestack';
import { useAgentSpawn } from '../lifecycle/useAgentSpawn';
import { useDashboardCardActions } from '../lifecycle/useDashboardCardActions';
import { useDashboardInteractions } from '../interaction/useDashboardInteractions';

// Composition root for the dashboard. Wires every dashboard hook together
// and returns exactly the prop bag DashboardCanvas renders. Kept out of
// Dashboard.tsx so the component file stays a thin shell.
export function useDashboardController(dashboardId: string, isActive: boolean) {
  const c = useClaudeTokens();
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;
  const {
    dashboardName, sessions, expandedSessionIds, cards, viewCards, browserCards,
    notes, pendingFocusNoteId, layoutInitialized, persistedExpandedSessionIds,
    zoomSensitivity, newAgentShortcut, browserHomepage, expandNewChats,
    autoRevealSubAgents, outputs, outputsLoaded, glowingAgentCards, glowingBrowserCards,
  } = useDashboardSelectors(dashboardId);
  // sessions is the top-level dict; useMemo on its identity so sessionList
  // is stable when sessions hasn't actually changed (RTK only swaps the dict
  // ref when one of its values changes, so this is the right granularity).
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);

  const contentBounds = useMemo(
    () => computeContentBounds(cards, viewCards, browserCards),
    [cards, viewCards, browserCards],
  );

  const canvas = useCanvasControls(zoomSensitivity, contentBounds, isActive);
  const selection = useDashboardSelection(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, viewportRef: canvas.viewportRef },
    cards,
    viewCards,
    browserCards,
    notes,
  );
  const {
    toolbarRef, toolbarOpen, setToolbarOpen, searchPaletteOpen, setSearchPaletteOpen,
    highlightedCardId, handleHighlightCard, autoFocusSessionId, setAutoFocusSessionId,
    setPendingSelectSessionId, focusedCardId, setFocusedCardId, newAgentBounce, setNewAgentBounce,
    spawnOriginsRef, measuredHeightsRef, measuredHeightsTick, handleMeasuredHeight,
    revealSpawnedRef, hasFittedRef, restoredExpandedRef,
  } = useDashboardUiState(selection, cards);

  const canvasStateRef = useRef({ panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom });
  canvasStateRef.current = { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom };
  // Stable getter , AgentCards read pan/zoom on demand during drag math.
  const getCanvasState = useCallback(() => canvasStateRef.current, []);

  const {
    multiDragDelta,
    liveDragInfo,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  } = useCardDrag({
    panX: canvas.panX,
    panY: canvas.panY,
    zoom: canvas.zoom,
    viewportRef: canvas.viewportRef,
    canvasActions: canvas.actions,
    selection,
  });

  const {
    handleCardSelect,
    handleBringToFront,
    handleViewportMouseDown,
    handleViewportMouseMove,
    handleViewportMouseUp,
    handleViewportDoubleClick,
    handleCardDoubleClick,
  } = useDashboardInteractions({
    canvas,
    selection,
    expandedSessionIds,
    isElementSelectMode,
    getCardRect,
    setFocusedCardId,
  });

  const { captureNow } = useDashboardThumbnail({
    isActive,
    dashboardId,
    layoutInitialized,
    viewportRef: canvas.viewportRef,
    contentRef: canvas.contentRef,
  });

  useDashboardLifecycle({
    isActive,
    dashboardId,
    layoutInitialized,
    sessions,
    expandedSessionIds,
    persistedExpandedSessionIds,
    viewCards,
    outputs,
    outputsLoaded,
    canvasActions: canvas.actions,
    handleHighlightCard,
    hasFittedRef,
    restoredExpandedRef,
  });

  // ---- Auto-reveal / collapse / unreveal sub-agent cards ----
  useSubAgentLifecycle({
    isActive,
    sessions,
    cards,
    layoutInitialized,
    autoRevealSubAgents,
    expandedSessionIds,
  });

  useLayoutSave({
    isActive,
    layoutInitialized,
    dashboardId,
    cards,
    viewCards,
    browserCards,
    notes,
    expandedSessionIds,
    captureNow,
  });

  useDashboardShortcuts({
    isActive,
    newAgentShortcut,
    selection,
    setToolbarOpen,
    setSearchPaletteOpen,
  });

  useDashboardClipboard({
    isActive,
    dashboardId,
    selection,
    sessions,
    cards,
    viewCards,
    browserCards,
    outputs,
    expandedSessionIds,
  });

  // ---- Arrow key card navigation (when zoomed in on a card) ----
  const { neighborDirections, shakeDirection } = useArrowNav({
    cards,
    viewCards,
    browserCards,
    zoom: canvas.zoom,
    isActive,
    focusedCardId,
    setFocusedCardId,
    canvasActions: canvas.actions,
    getCardRect,
  });

  const {
    handleBranchFromCard,
    handleNewAgent,
    handleToolbarCancel,
    handleToolbarSend,
  } = useAgentSpawn({
    cards,
    expandedSessionIds,
    dashboardId,
    expandNewChats,
    canvasActions: canvas.actions,
    viewportRef: canvas.viewportRef,
    toolbarRef,
    canvasStateRef,
    spawnOriginsRef,
    handleHighlightCard,
    setToolbarOpen,
    setAutoFocusSessionId,
    setPendingSelectSessionId,
  });

  const {
    handleAddView,
    handleAddBrowser,
    handleAddNote,
    handleHistoryResume,
    handleFitToView,
    handleTidy,
  } = useDashboardCardActions({
    expandedSessionIds,
    browserHomepage,
    pendingFocusNoteId,
    selection,
    canvasActions: canvas.actions,
    getCardRect,
    handleHighlightCard,
    setAutoFocusSessionId,
  });

  useSiblingRestack({
    isActive,
    expandedSessionIds,
    glowingAgentCards,
    glowingBrowserCards,
    cards,
    browserCards,
    measuredHeightsRef,
    measuredHeightsTick,
  });

  const tethers = useTethers({
    glowingAgentCards,
    glowingBrowserCards,
    cards,
    browserCards,
    expandedSessionIds,
    liveDragInfo,
    measuredHeightsRef,
    measuredHeightsTick,
    sessionList,
  });

  return {
    c, dashboardId, dashboardName, canvas, selection, sessions, sessionList,
    cards, viewCards, browserCards, notes, outputs, glowingAgentCards,
    expandedSessionIds, tethers, highlightedCardId, autoFocusSessionId,
    focusedCardId, pendingFocusNoteId, multiDragDelta, shakeDirection,
    neighborDirections, toolbarOpen, searchPaletteOpen, newAgentBounce,
    toolbarRef, spawnOriginsRef, revealSpawnedRef, measuredHeightsRef, getCanvasState,
    onViewportMouseDown: handleViewportMouseDown,
    onViewportMouseMove: handleViewportMouseMove,
    onViewportMouseUp: handleViewportMouseUp,
    onViewportDoubleClick: handleViewportDoubleClick,
    onCardSelect: handleCardSelect,
    onDragStart: handleCardDragStart,
    onDragMove: handleCardDragMove,
    onDragEnd: handleCardDragEnd,
    onCardDoubleClick: handleCardDoubleClick,
    onBringToFront: handleBringToFront,
    onBranch: handleBranchFromCard,
    onMeasuredHeight: handleMeasuredHeight,
    onHighlightCard: handleHighlightCard,
    onNewAgent: handleNewAgent,
    onToolbarCancel: handleToolbarCancel,
    onToolbarSend: handleToolbarSend,
    onAddView: handleAddView,
    onHistoryResume: handleHistoryResume,
    onAddBrowser: handleAddBrowser,
    onAddNote: handleAddNote,
    onNewAgentBounceEnd: () => setNewAgentBounce(false),
    onFitToView: handleFitToView,
    onTidy: handleTidy,
    onSearchPaletteClose: () => setSearchPaletteOpen(false),
  };
}
