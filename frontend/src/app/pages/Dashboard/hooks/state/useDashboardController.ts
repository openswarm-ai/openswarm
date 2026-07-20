import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppSelector } from '@/shared/hooks';
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
import { useWelcomeDraft } from '../lifecycle/useWelcomeDraft';
import { useOnboardingRevealSeed } from '../lifecycle/useOnboardingRevealSeed';
import { useOpportunisticUsageHarvest } from '../lifecycle/useOpportunisticUsageHarvest';
import { useDashboardThumbnail } from './useDashboardThumbnail';
import { useSiblingRestack } from '../lifecycle/useSiblingRestack';
import { useAgentSpawn } from '../lifecycle/useAgentSpawn';
import { useDashboardCardActions } from '../lifecycle/useDashboardCardActions';
import { useDashboardInteractions } from '../interaction/useDashboardInteractions';

// Composition root for the dashboard. Wires every dashboard hook together and returns exactly the prop bag DashboardCanvas renders. Kept out of Dashboard.tsx so the component file stays a thin shell.
export function useDashboardController(dashboardId: string, isActive: boolean) {
  const c = useClaudeTokens();
  const elementSelectionCtx = useElementSelection();
  const isElementSelectMode = elementSelectionCtx?.selectMode ?? false;
  const {
    dashboardName, sessions, expandedSessionIds, cards, viewCards, browserCards, keepAliveBrowserCards,
    workflowCards, workflowItems, workflowOpenCards, workflowsHub,
    pendingFocusWorkflowId, pendingFocusWorkflowsHub,
    notes, pendingFocusNoteId, layoutInitialized, persistedExpandedSessionIds,
    zoomSensitivity, newAgentShortcut, browserHomepage, expandNewChats,
    autoRevealSubAgents, outputs, outputsLoaded, glowingAgentCards, glowingBrowserCards,
  } = useDashboardSelectors(dashboardId);
  // sessions is the top-level dict; useMemo on its identity so sessionList is stable when sessions hasn't actually changed (RTK only swaps the dict ref when one of its values changes, so this is the right granularity).
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);

  // Run Monitor card geometry + its tether label ("Watching" live, "Viewing" done). Only "active" while its workflow still exists; otherwise the card is gone and the tether must not dangle (e.g. the workflow was trashed while watching).
  const workflowsMonitorIdRaw = useAppSelector((s) => s.dashboardLayout.workflowsMonitorId);
  const monitorActive = !!workflowsMonitorIdRaw && !!workflowItems[workflowsMonitorIdRaw];
  const workflowsMonitorId = monitorActive ? workflowsMonitorIdRaw : null;
  const workflowsMonitorCard = useAppSelector((s) =>
    (monitorActive ? s.dashboardLayout.workflowsMonitorCard : null));
  const monitorIsLive = useAppSelector((s) =>
    !!workflowsMonitorId && s.workflows.active.some((a) => a.workflow_id === workflowsMonitorId));
  const workflowsMonitorLabel = monitorIsLive ? 'Watching' : 'Viewing';

  // The session id of the run the monitor is showing, mirroring RunMonitor's pinned-or-latest pick, so its browser tether can anchor to the monitor card.
  const workflowsMonitorRunId = useAppSelector((s) => s.dashboardLayout.workflowsMonitorRunId);
  const monitorRuns = useAppSelector((s) => (workflowsMonitorId ? s.workflows.runs[workflowsMonitorId] : undefined));
  const allRuns = useAppSelector((s) => s.workflows.allRuns);
  const monitorRunSessionId = useMemo(() => {
    if (!workflowsMonitorId) return null;
    const run = workflowsMonitorRunId
      ? (monitorRuns || []).find((r) => r.id === workflowsMonitorRunId) || allRuns.find((r) => r.id === workflowsMonitorRunId)
      : (monitorRuns && monitorRuns[0]) || allRuns.find((r) => r.workflow_id === workflowsMonitorId);
    return run?.session_id || null;
  }, [workflowsMonitorId, workflowsMonitorRunId, monitorRuns, allRuns]);

  const contentBounds = useMemo(
    () => computeContentBounds(cards, viewCards, browserCards, workflowCards, workflowsHub),
    [cards, viewCards, browserCards, workflowCards, workflowsHub],
  );

  const canvas = useCanvasControls(zoomSensitivity, contentBounds, isActive);
  const selection = useDashboardSelection(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, viewportRef: canvas.viewportRef },
    cards,
    viewCards,
    browserCards,
    notes,
    workflowCards,
    workflowsHub,
  );
  const {
    toolbarRef, toolbarOpen, setToolbarOpen, searchPaletteOpen, setSearchPaletteOpen,
    highlightedCardId, handleHighlightCard, autoFocusSessionId, setAutoFocusSessionId,
    setPendingSelectSessionId, focusedCardId, setFocusedCardId, newAgentBounce, setNewAgentBounce,
    spawnOriginsRef, measuredHeightsRef, measuredHeightsTick, handleMeasuredHeight,
    revealSpawnedRef, hasFittedRef, restoredExpandedRef,
  } = useDashboardUiState(selection, cards);

  // Nudge the chat button while the canvas is empty; the first click dismisses it for this visit.
  const bounceDismissedRef = useRef(false);
  const canvasEmpty = layoutInitialized && sessionList.length === 0
    && Object.keys(viewCards).length === 0 && Object.keys(browserCards).length === 0;
  useEffect(() => {
    setNewAgentBounce(canvasEmpty && !bounceDismissedRef.current);
  }, [canvasEmpty, setNewAgentBounce]);

  // Live camera reads: gestures write the transform imperatively and only commit React state at gesture-end, so a render-synced ref would be stale mid-edge-pan (drag math) and inside the 140ms wheel-settle window (spawn placement). Both delegate to the canvas hook's live truth.
  const getCanvasState = useCallback(() => canvas.actions.getLiveState(), [canvas.actions]);
  const canvasStateRef = useMemo(() => ({
    get current() { return canvas.actions.getLiveState(); },
  }), [canvas.actions]);

  const {
    multiDragDelta,
    liveDragInfo,
    handleCardDragStart,
    handleCardDragMove,
    handleCardDragEnd,
  } = useCardDrag({
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

  // First-run: the onboarding cursor clicks New Agent -> handleNewAgent -> createWelcomeDraft, spawning the welcome chat. A manual New Agent click does the same when eligible.
  const { welcomeEligible, createWelcomeDraft } = useWelcomeDraft({
    dashboardId,
    canvasEmpty,
    expandedSessionIds,
    viewportRef: canvas.viewportRef,
    canvasStateRef,
    spawnOriginsRef,
  });

  // Onboarding v3 reveal: seeds the personalized note + welcome chat the instant the flow's curtain lifts.
  useOnboardingRevealSeed({
    isActive,
    dashboardId,
    expandedSessionIds,
    viewportRef: canvas.viewportRef,
    canvasStateRef,
    createWelcomeDraft,
    fitToCards: canvas.actions.fitToCards,
  });

  // Silently harvest the user's provider chat history the first time they open ChatGPT/Claude in-app, then sharpen their saved suggestions.
  useOpportunisticUsageHarvest();

  // ---- Auto-reveal / collapse / unreveal sub-agent cards ----
  useSubAgentLifecycle({
    isActive,
    sessions,
    cards,
    workflowOpenCards,
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
    workflowCards,
    workflowsHub,
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

  // Starter-prompt click: opens the composer with the prompt typed in (translucent, unsent), so the user reviews and hits send. A Build starter also passes the App Builder mode ('view-builder') so it builds in-place on the dashboard, no context switch to the Apps page. Both cleared when the composer closes.
  const [toolbarPrefill, setToolbarPrefill] = useState<string | undefined>(undefined);
  const [toolbarPrefillMode, setToolbarPrefillMode] = useState<string | undefined>(undefined);
  const handleStarter = useCallback((prompt: string, mode?: string) => {
    setToolbarPrefill(prompt);
    setToolbarPrefillMode(mode);
    setToolbarOpen(true);
  }, [setToolbarOpen]);
  useEffect(() => {
    if (!toolbarOpen) {
      if (toolbarPrefill) setToolbarPrefill(undefined);
      if (toolbarPrefillMode) setToolbarPrefillMode(undefined);
    }
  }, [toolbarOpen, toolbarPrefill, toolbarPrefillMode]);

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
    workflowCards,
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
    selection,
    canvasActions: canvas.actions,
    viewportRef: canvas.viewportRef,
    toolbarRef,
    canvasStateRef,
    spawnOriginsRef,
    handleHighlightCard,
    setToolbarOpen,
    setAutoFocusSessionId,
    setPendingSelectSessionId,
    welcomeEligible,
    onWelcomeNewAgent: createWelcomeDraft,
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
    viewportRef: canvas.viewportRef,
    canvasStateRef,
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
    workflowCards,
    workflowItems,
    workflowOpenCards,
    viewCards,
    outputs,
    expandedSessionIds,
    liveDragInfo,
    measuredHeightsRef,
    measuredHeightsTick,
    sessionList,
    workflowsHub,
    workflowsMonitorCard,
    workflowsMonitorLabel,
    monitorRunSessionId,
  });

  return {
    c, dashboardId, dashboardName, canvas, selection, sessions, sessionList,
    cards, viewCards, browserCards, keepAliveBrowserCards, notes, outputs, glowingAgentCards,
    workflowCards, workflowsHub,
    expandedSessionIds, tethers, highlightedCardId, autoFocusSessionId,
    focusedCardId, pendingFocusNoteId, multiDragDelta, shakeDirection,
    neighborDirections, toolbarOpen, searchPaletteOpen, newAgentBounce,
    toolbarRef, spawnOriginsRef, revealSpawnedRef, measuredHeightsRef, getCanvasState,
    toolbarPrefill,
    toolbarPrefillMode,
    onStarter: handleStarter,
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
    onNewAgentBounceEnd: () => {
      bounceDismissedRef.current = true;
      setNewAgentBounce(false);
    },
    onFitToView: handleFitToView,
    onTidy: handleTidy,
    onSearchPaletteClose: () => setSearchPaletteOpen(false),
  };
}
